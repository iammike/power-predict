// Strava sync orchestration. Pulls activities + streams, computes
// MMP, writes to D1. Pure-ish: takes env + fetch + a session lookup
// so it can be tested with stubbed dependencies.

import { extractMmp } from '../src/mmp.js';
import { normalizedPower } from '../src/aggregate.js';
import { listActivitiesAfter, fetchPowerStream, hasRealPower } from './strava-api.js';
import { refreshTokens } from './strava-oauth.js';

// Each /sync/recent call processes at most this many power-equipped
// rides before returning. Caps wall time well below the worker's
// 30 s ceiling and keeps progress feedback responsive.
const ACTIVITIES_PER_CALL = 20;

// Resolve a session token to an athlete id, or return null when the
// session is missing / expired.
export async function resolveSession(env, sessionToken) {
  if (!sessionToken) return null;
  const athleteId = await env.RATE_LIMIT.get(`session:${sessionToken}`);
  return athleteId ? Number(athleteId) : null;
}

// Fetch a usable access token for the athlete, refreshing through
// Strava's /oauth/token endpoint when the stored one is within 60 s
// of expiry. The refreshed pair is persisted back to D1.
export async function getValidAccessToken(env, athleteId, fetchImpl = fetch) {
  const row = await env.DB
    .prepare('SELECT access_token, refresh_token, token_expires_at FROM users WHERE id = ?')
    .bind(athleteId)
    .first();
  if (!row) throw new Error(`athlete ${athleteId} not found`);
  const now = Math.floor(Date.now() / 1000);
  if (row.token_expires_at > now + 60) return row.access_token;
  const fresh = await refreshTokens({
    clientId: env.STRAVA_CLIENT_ID,
    clientSecret: env.STRAVA_CLIENT_SECRET,
    refreshToken: row.refresh_token,
  }, fetchImpl);
  await env.DB
    .prepare('UPDATE users SET access_token=?, refresh_token=?, token_expires_at=? WHERE id=?')
    .bind(fresh.access_token, fresh.refresh_token, fresh.expires_at, athleteId)
    .run();
  return fresh.access_token;
}

// Run one slice of the sync. The caller polls until done=true.
//
// Approach:
//   1. List activities in the requested window (cached on the cursor
//      so we only hit /athlete/activities once per multi-call sync).
//   2. Filter to power-equipped rides we haven't ingested yet.
//   3. Process up to ACTIVITIES_PER_CALL: fetch stream, compute MMP
//      + summary stats, upsert activity + mmp_records.
//   4. Return the cursor + counts; the client re-calls until done.
export async function runSyncSlice({
  env,
  athleteId,
  days = 180,
  cursor = null,
  fetchImpl = fetch,
}) {
  const accessToken = await getValidAccessToken(env, athleteId, fetchImpl);

  // Resume the activity-id worklist if the client passed one;
  // otherwise list fresh. The worklist is the set of activity ids
  // we still need to ingest.
  let pending;
  let totalSeen;
  let totalWithPower;
  if (cursor && Array.isArray(cursor.pending)) {
    pending = cursor.pending;
    totalSeen = cursor.totalSeen;
    totalWithPower = cursor.totalWithPower;
  } else {
    const after = Math.floor(Date.now() / 1000) - days * 86400;
    const all = await listActivitiesAfter({ accessToken, afterEpoch: after }, fetchImpl);
    totalSeen = all.length;
    const powered = all.filter(hasRealPower);
    totalWithPower = powered.length;
    // Skip the ones we've already ingested. Strava activity ids are
    // stable, so we trust the rows already in D1.
    const existing = await env.DB
      .prepare(`SELECT id FROM activities WHERE user_id = ? AND id IN (${powered.map(() => '?').join(',') || 'NULL'})`)
      .bind(athleteId, ...powered.map((a) => a.id))
      .all();
    const existingIds = new Set((existing.results || []).map((r) => r.id));
    pending = powered
      .filter((a) => !existingIds.has(a.id))
      .map((a) => ({
        id: a.id,
        startTime: Math.floor(new Date(a.start_date).getTime() / 1000),
        durationS: a.elapsed_time,
        distanceM: a.distance,
        avgPower: a.average_watts ?? null,
      }));
  }

  const slice = pending.slice(0, ACTIVITIES_PER_CALL);
  const remaining = pending.slice(slice.length);
  const errors = [];
  let processed = 0;

  for (const a of slice) {
    try {
      const stream = await fetchPowerStream({ accessToken, activityId: a.id }, fetchImpl);
      if (!stream || stream.length === 0) continue;
      const mmp = extractMmp(stream);
      const npRaw = normalizedPower(stream);
      const npW = Number.isFinite(npRaw) && npRaw > 0 ? npRaw : a.avgPower;
      // Insert activity row; the unique primary key on Strava ids
      // makes this idempotent across retries.
      await env.DB
        .prepare(
          `INSERT OR REPLACE INTO activities
            (id, user_id, start_time, duration_s, distance_m, avg_power, normalized_power,
             intensity_factor, tss, has_power, source, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, 'api', ?)`
        )
        .bind(
          a.id, athleteId, a.startTime, a.durationS, a.distanceM,
          a.avgPower, npW, Math.floor(Date.now() / 1000),
        )
        .run();
      // Bulk insert the per-duration MMP records. We delete + insert
      // so a re-sync of the same activity refreshes the values
      // rather than leaving a partial pre-anomaly-filter set.
      await env.DB.prepare('DELETE FROM mmp_records WHERE activity_id = ?').bind(a.id).run();
      const inserts = [];
      for (const [d, p] of Object.entries(mmp)) {
        if (!Number.isFinite(p)) continue;
        inserts.push(env.DB
          .prepare('INSERT INTO mmp_records (activity_id, duration_s, power_w, is_true_mmp) VALUES (?, ?, ?, 1)')
          .bind(a.id, Number(d), p));
      }
      if (inserts.length) await env.DB.batch(inserts);
      processed++;
    } catch (err) {
      errors.push({ id: a.id, message: err?.message || String(err) });
    }
  }

  // Bump last_sync_at on every slice so the user sees progress even
  // mid-sync; the final timestamp lands on the last call.
  await env.DB
    .prepare('UPDATE users SET last_sync_at = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), athleteId)
    .run();

  const done = remaining.length === 0;
  return {
    done,
    processed,
    totalSeen,
    totalWithPower,
    remaining: remaining.length,
    errors,
    cursor: done ? null : { pending: remaining, totalSeen, totalWithPower },
  };
}

// Read the user's stored MMP records back out as an array of
// `{ id, startTime, durationS, distanceM, avgPower, npW, mmp }` —
// the same shape the frontend feeds into its renderCurves pipeline.
export async function loadActivities(env, athleteId) {
  const acts = await env.DB
    .prepare(`SELECT id, start_time, duration_s, distance_m, avg_power, normalized_power
              FROM activities
              WHERE user_id = ? AND has_power = 1
              ORDER BY start_time ASC`)
    .bind(athleteId)
    .all();
  const rows = acts.results || [];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const mmps = await env.DB
    .prepare(`SELECT activity_id, duration_s, power_w
              FROM mmp_records
              WHERE activity_id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all();
  const mmpByActivity = new Map();
  for (const m of mmps.results || []) {
    let bucket = mmpByActivity.get(m.activity_id);
    if (!bucket) { bucket = {}; mmpByActivity.set(m.activity_id, bucket); }
    bucket[m.duration_s] = m.power_w;
  }
  return rows.map((r) => ({
    stravaId: String(r.id),
    startTime: r.start_time * 1000, // ms in the frontend's IDB shape
    durationS: r.duration_s,
    distanceM: r.distance_m,
    avgPower: r.avg_power,
    npW: r.normalized_power,
    mmp: mmpByActivity.get(r.id) || {},
  }));
}
