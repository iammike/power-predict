// Strava sync orchestration. Pulls activities + streams, computes
// MMP, writes to D1. Pure-ish: takes env + fetch + a session lookup
// so it can be tested with stubbed dependencies.

import { extractMmp } from '../src/mmp.js';
import { normalizedPower } from '../src/aggregate.js';
import { listActivitiesAfter, fetchPowerStream, hasRealPower } from './strava-api.js';
import { refreshTokens } from './strava-oauth.js';

// Each /sync/recent call processes at most this many power-equipped
// rides before returning. Caps wall time well below the worker's
// 30 s ceiling and keeps progress feedback responsive. The first
// call (no cursor) does the activity listing only and processes 0
// streams, so the streams-only call rate is a clean N per slice.
//
// In addition to the per-slice cap, a wall-time guard inside the
// loop breaks out early if the slice has been running long enough
// that one more stream fetch could push past the worker's 30 s
// budget. This way we adapt to slow Strava responses instead of
// counting on the static cap alone.
const ACTIVITIES_PER_CALL = 15;
const SLICE_WALL_BUDGET_MS = 22_000;

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
  knownIds = [],
  fetchImpl = fetch,
}) {
  const accessToken = await getValidAccessToken(env, athleteId, fetchImpl);

  // The first slice (no cursor) does the listing + dedup + builds
  // the worklist, then returns immediately with zero processed.
  // Streams are fetched only on subsequent calls — keeps each slice
  // well under the worker's 30 s budget even if Strava is sluggish
  // during listing or any single stream fetch is slow.
  if (!cursor) {
    const after = Math.floor(Date.now() / 1000) - days * 86400;
    const all = await listActivitiesAfter({ accessToken, afterEpoch: after }, fetchImpl);
    const totalSeen = all.length;
    const powered = all.filter(hasRealPower);
    const totalWithPower = powered.length;
    // Skip the ones we've already ingested in D1, plus anything the
    // client tells us is already in its IndexedDB cache (archive
    // ingest doesn't write to D1, so the worker would otherwise
    // re-fetch streams the client already has).
    const existing = await env.DB
      .prepare('SELECT id FROM activities WHERE user_id = ?')
      .bind(athleteId)
      .all();
    const skip = new Set((existing.results || []).map((r) => r.id));
    for (const id of knownIds) {
      const n = Number(id);
      if (Number.isFinite(n)) skip.add(n);
    }
    const pending = powered
      .filter((a) => !skip.has(a.id))
      .map((a) => ({
        id: a.id,
        startTime: Math.floor(new Date(a.start_date).getTime() / 1000),
        durationS: a.elapsed_time,
        distanceM: a.distance,
        avgPower: a.average_watts ?? null,
      }));
    return {
      done: pending.length === 0,
      processed: 0,
      totalSeen,
      totalWithPower,
      remaining: pending.length,
      errors: [],
      cursor: pending.length > 0 ? { pending, totalSeen, totalWithPower } : null,
    };
  }

  // Subsequent slice: process up to ACTIVITIES_PER_CALL streams or
  // until the wall-time guard fires, whichever comes first.
  const sliceStartedAt = Date.now();
  const pending = cursor.pending;
  const totalSeen = cursor.totalSeen;
  const totalWithPower = cursor.totalWithPower;
  const slice = pending.slice(0, ACTIVITIES_PER_CALL);
  let remaining = pending.slice(slice.length);
  const errors = [];
  let processed = 0;

  for (let i = 0; i < slice.length; i++) {
    // Wall-time guard: if we're already past the budget, push what's
    // left back onto the worklist and bail. Better to return early
    // with a smaller chunk than risk the worker hitting its hard
    // 30 s limit and dropping the response entirely.
    if (Date.now() - sliceStartedAt >= SLICE_WALL_BUDGET_MS) {
      remaining = slice.slice(i).concat(remaining);
      break;
    }
    const a = slice[i];
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

  const elapsedMs = Date.now() - sliceStartedAt;
  const done = remaining.length === 0;
  return {
    elapsedMs,
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
  // Pull every mmp_record joined to one of this user's activities;
  // SQLite handles the join fine at this size and we avoid an
  // IN-list with thousands of bind params.
  const mmps = await env.DB
    .prepare(`SELECT m.activity_id, m.duration_s, m.power_w
              FROM mmp_records m
              JOIN activities a ON a.id = m.activity_id
              WHERE a.user_id = ?`)
    .bind(athleteId)
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
