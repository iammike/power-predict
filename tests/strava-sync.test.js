import { describe, it, expect } from 'vitest';
import {
  resolveSession,
  getValidAccessToken,
  runSyncSlice,
} from '../worker/sync.js';

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
          const [id, user_id, start_time, duration_s, distance_m, avg_power, normalized_power, , , , , ingested_at] = b;
          state.activities.set(id, { id, user_id, start_time, duration_s, distance_m, avg_power, normalized_power, ingested_at, has_power: 1 });
        } else if (sql.startsWith('DELETE FROM mmp_records')) {
          state.mmp = state.mmp.filter((m) => m.activity_id !== b[0]);
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
        if (sql.startsWith('SELECT id FROM activities')) {
          const ids = b.slice(1);
          const results = [...state.activities.values()]
            .filter((a) => a.user_id === b[0] && ids.includes(a.id))
            .map((a) => ({ id: a.id }));
          return { results };
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
  it('lists, filters power-equipped, fetches stream, and writes MMP rows', async () => {
    const db = makeDb();
    db.state.users.set(42, {
      access_token: 'tok', refresh_token: 'r',
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const calls = [];
    const stream = Array.from({ length: 600 }, () => 220); // 10-min steady 220 W
    const fakeFetch = async (urlStr) => {
      calls.push(urlStr);
      if (urlStr.includes('/athlete/activities')) {
        // Two rides; only one has device_watts.
        return new Response(JSON.stringify([
          { id: 1001, type: 'Ride', device_watts: true, average_watts: 200,
            start_date: '2026-01-01T00:00:00Z', elapsed_time: 600, distance: 5000 },
          { id: 1002, type: 'Ride', device_watts: false, average_watts: 200,
            start_date: '2026-01-02T00:00:00Z', elapsed_time: 600, distance: 5000 },
        ]), { status: 200 });
      }
      if (urlStr.includes('/streams')) {
        return new Response(JSON.stringify({ watts: { data: stream } }), { status: 200 });
      }
      throw new Error(`unexpected url: ${urlStr}`);
    };
    const env = {
      DB: db,
      RATE_LIMIT: makeKv(),
      STRAVA_CLIENT_ID: 'cid',
      STRAVA_CLIENT_SECRET: 'sec',
    };
    const out = await runSyncSlice({ env, athleteId: 42, days: 180, fetchImpl: fakeFetch });
    expect(out.totalSeen).toBe(2);
    expect(out.totalWithPower).toBe(1);
    expect(out.processed).toBe(1);
    expect(out.done).toBe(true);
    expect(out.errors).toHaveLength(0);
    // Activity row written:
    expect(db.state.activities.get(1001)).toBeDefined();
    // MMP records written for the durations covered by a 600-sample stream:
    const durations = db.state.mmp.filter((m) => m.activity_id === 1001).map((m) => m.duration_s);
    expect(durations).toContain(60);
    expect(durations).toContain(300);
  });

  it('skips activities already present in D1 to avoid re-ingesting', async () => {
    const db = makeDb();
    db.state.users.set(42, {
      access_token: 'tok', refresh_token: 'r',
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    db.state.activities.set(1001, { id: 1001, user_id: 42, has_power: 1, start_time: 0 });
    const fakeFetch = async (urlStr) => {
      if (urlStr.includes('/athlete/activities')) {
        return new Response(JSON.stringify([
          { id: 1001, type: 'Ride', device_watts: true, average_watts: 200,
            start_date: '2026-01-01T00:00:00Z', elapsed_time: 600, distance: 5000 },
        ]), { status: 200 });
      }
      throw new Error('should not fetch streams when already ingested');
    };
    const env = { DB: db, RATE_LIMIT: makeKv(), STRAVA_CLIENT_ID: 'c', STRAVA_CLIENT_SECRET: 's' };
    const out = await runSyncSlice({ env, athleteId: 42, fetchImpl: fakeFetch });
    expect(out.totalWithPower).toBe(1);
    expect(out.processed).toBe(0);
    expect(out.done).toBe(true);
  });
});
