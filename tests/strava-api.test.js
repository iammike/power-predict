import { describe, it, expect } from 'vitest';
import { listActivitiesAfter, fetchPowerStream } from '../worker/strava-api.js';

// No-op sleep so the backoff doesn't actually wait during tests.
const noSleep = { sleep: async () => {} };

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('listActivitiesAfter retry', () => {
  it('retries a 500 and succeeds when Strava recovers', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 3) return jsonRes(500, { message: 'error' });
      return jsonRes(200, []); // empty page -> loop breaks
    };
    const out = await listActivitiesAfter(
      { accessToken: 't', afterEpoch: 0 },
      fetchImpl,
      noSleep,
    );
    expect(calls).toBe(3); // two 500s, then a 200
    expect(out).toEqual([]);
  });

  it('throws after exhausting retries on a persistent 500', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return jsonRes(500, { message: 'error' }); };
    await expect(
      listActivitiesAfter({ accessToken: 't', afterEpoch: 0 }, fetchImpl, { ...noSleep, retries: 3 }),
    ).rejects.toThrow(/strava list activities 500/);
    expect(calls).toBe(4); // initial + 3 retries
  });

  it('does not retry a 4xx', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return jsonRes(401, { message: 'Authorization Error' }); };
    await expect(
      listActivitiesAfter({ accessToken: 't', afterEpoch: 0 }, fetchImpl, noSleep),
    ).rejects.toThrow(/strava list activities 401/);
    expect(calls).toBe(1); // no retry
  });
});

describe('fetchPowerStream retry', () => {
  it('retries a 503 then returns the watts stream', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 2) return jsonRes(503, { message: 'error' });
      return jsonRes(200, { watts: { data: [100, 200, 300] } });
    };
    const out = await fetchPowerStream({ accessToken: 't', activityId: 1 }, fetchImpl, noSleep);
    expect(calls).toBe(2);
    expect(out).toEqual([100, 200, 300]);
  });

  it('still short-circuits a 404 to null without retrying', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return jsonRes(404, {}); };
    const out = await fetchPowerStream({ accessToken: 't', activityId: 1 }, fetchImpl, noSleep);
    expect(out).toBeNull();
    expect(calls).toBe(1);
  });
});
