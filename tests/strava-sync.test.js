import { describe, it, expect } from 'vitest';
import {
  resolveSession,
  getValidAccessToken,
  runSyncSlice,
} from '../worker/sync.js';
import { MMP_VERSION } from '../src/mmp.js';

// ---------- D1 stub ----------
//
// Mimics the prepare/bind/run/all/first/batch chain wrangler exposes.
// Routes by the SQL string prefix; tests below pre-seed `state` and
// inspect it after each call.

function makeDb(state = {}) {
  state.users ??= new Map();      // id → row
  state.activities ??= new Map(); // id → row
  state.mmp ??= [];               // {activity_id, duration_s, power_w}
  function makeStmt(sql) {
    let bound = [];
    return {
      bind: (...args) => { bound = args; return makeStmt.last = makeStmt.cur = { ...makeStmt.cur, sql, bound, ...api(sql, () => bound) }; },
    };
  }
  function api(sql, getBound) {
    return {
      async first() {
        const b = getBound();
        if (sql.startsWith('SELECT access_token')) {
          return state.users.get(b[0]) || null;
        }
        return null;
      },
      async run() {
        const b = getBound();
        if (sql.startsWith('UPDATE users SET access_token')) {
          const [accessToken, refreshToken, expiresAt, id] = b;
          const u = state.users.get(id) || {};
          state.users.set(id, { ...u, access_token: accessToken, refresh_token: refreshToken, token_expires_at: expiresAt });
        } else if (sql.startsWith('INSERT OR REPLACE INTO activities')) {
          const [id, user_id, start_time, duration_s, distance_m, avg_power, normalized_power, ingested_at, mmp_version] = b;
          state.activities.set(id, { id, user_id, start_time, duration_s, distance_m, avg_power, normalized_power, ingested_at, mmp_version, has_power: 1 });
        } else if (sql.startsWith('DELETE FROM mmp_records')) {
          state.mmp = state.mmp.filter((m) => m.activity_id !== b[0]);
        } else if (sql.startsWith('DELETE FROM activities')) {
          state.activities.delete(b[0]);
        } else if (sql.startsWith('UPDATE users SET last_sync_at')) {
          const u = state.users.get(b[1]) || {};
          state.users.set(b[1], { ...u, last_sync_at: b[0] });
        } else if (sql.startsWith('INSERT INTO mmp_records')) {
          state.mmp.push({ activity_id: b[0], duration_s: b[1], power_w: b[2] });
        }
        return { changes: 1 };
      },
      async all() {
        const b = getBound();
        if (sql.startsWith('SELECT id, mmp_version FROM activities')) {
          return { results: [...state.activities.values()].map((a) => ({ id: a.id, mmp_version: a.mmp_version ?? null })) };
        }
        return { results: [] };
      },
    };
  }
  return {
    state,
    prepare(sql) { return makeStmt(sql); },
    async batch(stmts) {
      for (const s of stmts) await s.run();
      return [];
    },
  };
}

function makeKv(map = new Map()) {
  return {
    map,
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
  };
}

describe('resolveSession', () => {
  it('returns athlete id for a known session token', async () => {
    const env = { RATE_LIMIT: makeKv(new Map([['session:abc', '7']])) };
    expect(await resolveSession(env, 'abc')).toBe(7);
  });
  it('returns null for missing or unknown tokens', async () => {
    const env = { RATE_LIMIT: makeKv() };
    expect(await resolveSession(env, '')).toBeNull();
    expect(await resolveSession(env, 'nope')).toBeNull();
  });
});

describe('getValidAccessToken', () => {
  it('returns the stored token when not near expiry', async () => {
    const db = makeDb();
    db.state.users.set(1, {
      access_token: 'cur', refresh_token: 'r',
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const env = { DB: db, STRAVA_CLIENT_ID: 'x', STRAVA_CLIENT_SECRET: 'y' };
    const fakeFetch = async () => { throw new Error('refresh should not be called'); };
    expect(await getValidAccessToken(env, 1, fakeFetch)).toBe('cur');
  });

  it('refreshes when within the 60-second buffer and persists the new pair', async () => {
    const db = makeDb();
    db.state.users.set(1, {
      access_token: 'old', refresh_token: 'rt',
      token_expires_at: Math.floor(Date.now() / 1000) + 30,
    });
    const env = { DB: db, STRAVA_CLIENT_ID: 'x', STRAVA_CLIENT_SECRET: 'y' };
    const fakeFetch = async () => new Response(JSON.stringify({
      access_token: 'fresh', refresh_token: 'rt2', expires_at: 9999999999,
    }), { status: 200 });
    expect(await getValidAccessToken(env, 1, fakeFetch)).toBe('fresh');
    expect(db.state.users.get(1).access_token).toBe('fresh');
    expect(db.state.users.get(1).refresh_token).toBe('rt2');
  });
});

describe('runSyncSlice', () => {
  it('first slice lists + dedupes + builds the worklist (no streams)', async () => {
    const db = makeDb();
    db.state.users.set(42, {
      access_token: 'tok', refresh_token: 'r',
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const fakeFetch = async (urlStr) => {
      if (urlStr.includes('/athlete/activities')) {
        return new Response(JSON.stringify([
          { id: 1001, type: 'Ride', device_watts: true, average_watts: 200,
            start_date: '2026-01-01T00:00:00Z', elapsed_time: 600, distance: 5000 },
          { id: 1002, type: 'Ride', device_watts: false, average_watts: 200,
            start_date: '2026-01-02T00:00:00Z', elapsed_time: 600, distance: 5000 },
        ]), { status: 200 });
      }
      throw new Error('first slice should not fetch streams');
    };
    const env = { DB: db, RATE_LIMIT: makeKv(), STRAVA_CLIENT_ID: 'c', STRAVA_CLIENT_SECRET: 's' };
    const out = await runSyncSlice({ env, athleteId: 42, days: 180, fetchImpl: fakeFetch });
    expect(out.processed).toBe(0);
    expect(out.totalSeen).toBe(2);
    expect(out.totalWithPower).toBe(1);
    expect(out.remaining).toBe(1);
    expect(out.done).toBe(false);
    expect(out.cursor.pending).toHaveLength(1);
    expect(out.cursor.pending[0].id).toBe(1001);
  });

  it('excludes non-ride activities (runs, e-bikes) even when power-equipped', async () => {
    const db = makeDb();
    db.state.users.set(42, {
      access_token: 'tok', refresh_token: 'r',
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const fakeFetch = async (urlStr) => {
      if (urlStr.includes('/athlete/activities')) {
        return new Response(JSON.stringify([
          // A real ride with power — kept.
          { id: 1, type: 'Ride', sport_type: 'Ride', device_watts: true, average_watts: 200,
            start_date: '2026-01-01T00:00:00Z', elapsed_time: 600, distance: 5000 },
          // A run with a running power meter — dropped despite device_watts.
          { id: 2, type: 'Run', sport_type: 'Run', device_watts: true, average_watts: 300,
            start_date: '2026-01-02T00:00:00Z', elapsed_time: 600, distance: 5000 },
          // E-bike (legacy type says Ride, sport_type reveals the assist) — dropped.
          { id: 3, type: 'Ride', sport_type: 'EBikeRide', device_watts: true, average_watts: 250,
            start_date: '2026-01-03T00:00:00Z', elapsed_time: 600, distance: 5000 },
        ]), { status: 200 });
      }
      throw new Error('first slice should not fetch streams');
    };
    const env = { DB: db, RATE_LIMIT: makeKv(), STRAVA_CLIENT_ID: 'c', STRAVA_CLIENT_SECRET: 's' };
    const out = await runSyncSlice({ env, athleteId: 42, fetchImpl: fakeFetch });
    expect(out.totalSeen).toBe(3);
    expect(out.totalWithPower).toBe(1);
    expect(out.cursor.pending.map((p) => p.id)).toEqual([1]);
  });

  it('reconciles previously-synced non-rides out of D1 and reports their ids', async () => {
    const db = makeDb();
    db.state.users.set(42, {
      access_token: 'tok', refresh_token: 'r',
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    // A run was synced before the ride-only filter existed — it's
    // sitting in D1 with MMP rows.
    db.state.activities.set(2, { id: 2, user_id: 42, has_power: 1, start_time: 0 });
    db.state.mmp.push({ activity_id: 2, duration_s: 1200, power_w: 314 });
    const fakeFetch = async (urlStr) => {
      if (urlStr.includes('/athlete/activities')) {
        return new Response(JSON.stringify([
          { id: 1, type: 'Ride', sport_type: 'Ride', device_watts: true, average_watts: 200,
            start_date: '2026-05-01T00:00:00Z', elapsed_time: 600, distance: 5000 },
          { id: 2, type: 'Run', sport_type: 'Run', device_watts: true, average_watts: 314,
            start_date: '2026-05-06T00:00:00Z', elapsed_time: 1200, distance: 8000 },
        ]), { status: 200 });
      }
      throw new Error('first slice should not fetch streams');
    };
    const env = { DB: db, RATE_LIMIT: makeKv(), STRAVA_CLIENT_ID: 'c', STRAVA_CLIENT_SECRET: 's' };
    const out = await runSyncSlice({ env, athleteId: 42, fetchImpl: fakeFetch });
    // The run (id 2) is deleted from D1 along with its MMP rows, and
    // reported back as a removed Strava id (string form).
    expect(db.state.activities.has(2)).toBe(false);
    expect(db.state.mmp.some((m) => m.activity_id === 2)).toBe(false);
    expect(out.removedIds).toEqual(['2']);
    // The fresh ride (id 1) is still queued for stream fetching.
    expect(out.cursor.pending.map((p) => p.id)).toEqual([1]);
  });

  it('second slice fetches streams and writes MMP rows', async () => {
    const db = makeDb();
    db.state.users.set(42, {
      access_token: 'tok', refresh_token: 'r',
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const stream = Array.from({ length: 600 }, () => 220);
    const fakeFetch = async (urlStr) => {
      if (urlStr.includes('/streams')) {
        return new Response(JSON.stringify({ watts: { data: stream } }), { status: 200 });
      }
      throw new Error(`unexpected url: ${urlStr}`);
    };
    const env = { DB: db, RATE_LIMIT: makeKv(), STRAVA_CLIENT_ID: 'c', STRAVA_CLIENT_SECRET: 's' };
    const cursor = {
      pending: [{ id: 1001, startTime: 1735689600, durationS: 600, distanceM: 5000, avgPower: 200 }],
      totalSeen: 1, totalWithPower: 1,
    };
    const out = await runSyncSlice({ env, athleteId: 42, days: 180, cursor, fetchImpl: fakeFetch });
    expect(out.processed).toBe(1);
    expect(out.done).toBe(true);
    expect(db.state.activities.get(1001)).toBeDefined();
    const durations = db.state.mmp.filter((m) => m.activity_id === 1001).map((m) => m.duration_s);
    expect(durations).toContain(60);
    expect(durations).toContain(300);
  });

  it('skips activities already in D1', async () => {
    const db = makeDb();
    db.state.users.set(42, {
      access_token: 'tok', refresh_token: 'r',
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    db.state.activities.set(1001, { id: 1001, user_id: 42, has_power: 1, start_time: 0, mmp_version: MMP_VERSION });
    const fakeFetch = async (urlStr) => {
      if (urlStr.includes('/athlete/activities')) {
        return new Response(JSON.stringify([
          { id: 1001, type: 'Ride', device_watts: true, average_watts: 200,
            start_date: '2026-01-01T00:00:00Z', elapsed_time: 600, distance: 5000 },
        ]), { status: 200 });
      }
      throw new Error('should not fetch streams for current-version rides');
    };
    const env = { DB: db, RATE_LIMIT: makeKv(), STRAVA_CLIENT_ID: 'c', STRAVA_CLIENT_SECRET: 's' };
    const out = await runSyncSlice({ env, athleteId: 42, fetchImpl: fakeFetch });
    expect(out.totalWithPower).toBe(1);
    expect(out.remaining).toBe(0);
    expect(out.done).toBe(true);
    expect(out.cursor).toBeNull();
  });

  it('skips activities listed in knownIds (IDB cache from archive)', async () => {
    const db = makeDb();
    db.state.users.set(42, {
      access_token: 'tok', refresh_token: 'r',
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const fakeFetch = async (urlStr) => {
      if (urlStr.includes('/athlete/activities')) {
        return new Response(JSON.stringify([
          { id: 1001, type: 'Ride', device_watts: true, average_watts: 200,
            start_date: '2026-01-01T00:00:00Z', elapsed_time: 600, distance: 5000 },
          { id: 1002, type: 'Ride', device_watts: true, average_watts: 200,
            start_date: '2026-01-02T00:00:00Z', elapsed_time: 600, distance: 5000 },
        ]), { status: 200 });
      }
      throw new Error('first slice should not fetch streams');
    };
    const env = { DB: db, RATE_LIMIT: makeKv(), STRAVA_CLIENT_ID: 'c', STRAVA_CLIENT_SECRET: 's' };
    const out = await runSyncSlice({
      env, athleteId: 42, knownIds: ['1001'], fetchImpl: fakeFetch,
    });
    expect(out.totalWithPower).toBe(2);
    expect(out.remaining).toBe(1);
    expect(out.cursor.pending[0].id).toBe(1002);
  });
});

describe('mmp version re-extraction', () => {
  // Minimal Strava listing + stream fetch stubs. One ride, in the window.
  function makeFetchImpl(activityId, durationS) {
    return async (url) => {
      const u = String(url);
      if (u.includes('/athlete/activities')) {
        return new Response(JSON.stringify([{
          id: activityId, type: 'Ride', start_date: '2026-06-20T13:00:00Z',
          elapsed_time: durationS, distance: 100000, average_watts: 200, device_watts: true,
        }]), { status: 200 });
      }
      if (u.includes('/streams')) {
        return new Response(JSON.stringify({ watts: { data: new Array(durationS).fill(200) } }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
  }

  it('does NOT skip a ride whose stored mmp_version is stale (null)', async () => {
    const state = {};
    const db = makeDb(state);
    state.users.set(7, { id: 7, access_token: 't', refresh_token: 'r', token_expires_at: 9e12 });
    state.activities.set(555, { id: 555, user_id: 7, start_time: 1, duration_s: 100, mmp_version: null, has_power: 1 });
    const env = { DB: db, STRAVA_CLIENT_ID: '1', STRAVA_CLIENT_SECRET: 's' };
    const fetchImpl = makeFetchImpl(555, 120);
    const first = await runSyncSlice({ env, athleteId: 7, days: 180, cursor: null, knownIds: [], fetchImpl });
    expect(first.remaining).toBe(1); // stale ride queued for re-extraction, not skipped
  });

  it('skips a ride already at the current mmp_version', async () => {
    const state = {};
    const db = makeDb(state);
    state.users.set(7, { id: 7, access_token: 't', refresh_token: 'r', token_expires_at: 9e12 });
    state.activities.set(555, { id: 555, user_id: 7, start_time: 1, duration_s: 100, mmp_version: 2, has_power: 1 });
    const env = { DB: db, STRAVA_CLIENT_ID: '1', STRAVA_CLIENT_SECRET: 's' };
    const fetchImpl = makeFetchImpl(555, 120);
    const first = await runSyncSlice({ env, athleteId: 7, days: 180, cursor: null, knownIds: [], fetchImpl });
    expect(first.remaining).toBe(0); // current-version ride skipped
  });

  it('stamps MMP_VERSION on re-extracted rides', async () => {
    const state = {};
    const db = makeDb(state);
    state.users.set(7, { id: 7, access_token: 't', refresh_token: 'r', token_expires_at: 9e12 });
    state.activities.set(555, { id: 555, user_id: 7, start_time: 1, duration_s: 100, mmp_version: null, has_power: 1 });
    const env = { DB: db, STRAVA_CLIENT_ID: '1', STRAVA_CLIENT_SECRET: 's' };
    const fetchImpl = makeFetchImpl(555, 120);
    const first = await runSyncSlice({ env, athleteId: 7, days: 180, cursor: null, knownIds: [], fetchImpl });
    const second = await runSyncSlice({ env, athleteId: 7, days: 180, cursor: first.cursor, knownIds: [], fetchImpl });
    expect(second.processed).toBe(1);
    expect(state.activities.get(555).mmp_version).toBe(MMP_VERSION);
  });
});
