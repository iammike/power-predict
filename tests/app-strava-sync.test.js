// DOM-wiring integration tests for triggerStravaSync and the Strava
// connect/disconnect flow (#239, part 3 of 3 — see tests/app-render-flow.test.js
// for part 1's mountApp/fixtures harness and tests/app-archive.test.js for
// part 2's handleArchive coverage, both reused here). src/strava-session.js
// calls global fetch directly with no injectable seam, so this mocks fetch
// the same way tests/strava-session.test.js already does (a local
// jsonResponse(status, body) helper + vi.stubGlobal('fetch', ...)).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountApp, resetIndexedDb } from './helpers/mountApp.js';
import { makeRide, makeRides } from './helpers/fixtures.js';
import { saveActivities, loadActivities } from '../src/storage.js';
import { saveSession, loadSession, API_BASE } from '../src/strava-session.js';

vi.mock('uplot', () => {
  class FakeUPlot {
    constructor(opts) { this.opts = opts; }
    setSize() {}
    destroy() {}
  }
  return { default: FakeUPlot };
});

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Routes by URL substring so a single stub can answer both endpoints
// triggerStravaSync drives in sequence: syncRecent()'s POST /sync/recent
// loop (one entry per call; the last entry repeats for any call past the
// end, so a single-slice `{done: true}` array of length 1 is enough for
// every happy-path test) and fetchSyncedActivities()'s GET /activities/recent.
function stubFetch({ syncSlices = [{ processed: 0, remaining: 0, done: true }], activities = [], activitiesStatus = 200 }) {
  let callIndex = 0;
  const fetchMock = vi.fn(async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/sync/recent')) {
      const slice = syncSlices[Math.min(callIndex, syncSlices.length - 1)];
      callIndex += 1;
      if (slice.status) return jsonResponse(slice.status, slice.body ?? {});
      return jsonResponse(200, slice);
    }
    if (urlStr.includes('/activities/recent')) {
      if (activitiesStatus !== 200) return jsonResponse(activitiesStatus, { error: 'boom' });
      return jsonResponse(200, { activities });
    }
    throw new Error(`stubFetch: unexpected URL ${urlStr}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function bannerText() {
  return document.querySelector('.status-banner')?.textContent ?? '';
}

async function mountConnected({ withCachedRide = false } = {}) {
  await resetIndexedDb();
  if (withCachedRide) await saveActivities(makeRides(1));
  await saveSession({ session: 'tok-123', athleteId: '999' });
  await mountApp({ resetDb: false });
}

describe('triggerStravaSync happy path', () => {
  it('persists synced rides, shows the completion banner, and renders the table', async () => {
    await mountConnected();
    const remoteRide = makeRide({ stravaId: '555' });
    stubFetch({ activities: [remoteRide] });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('Sync complete')) throw new Error('not settled yet');
    });
    expect(bannerText()).toContain('1');
    expect(bannerText()).toContain('new ride added');
    expect(document.querySelector('.mmp-table')).toBeTruthy();

    const saved = await loadActivities();
    expect(saved).toHaveLength(1);
    expect(saved[0].startTime).toBe(remoteRide.startTime);
    expect(saved[0].stravaId).toBe('555');
  });

  it('shows a no-rides-in-window message without touching an existing cache', async () => {
    await mountConnected({ withCachedRide: true });
    stubFetch({ activities: [] });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('No power-equipped rides in the synced window')) {
        throw new Error('not settled yet');
      }
    });
    expect(await loadActivities()).toHaveLength(1);
  });

  it('merges into an existing cache and reports "already had everything" when nothing is new', async () => {
    await resetIndexedDb();
    const existing = makeRide({ stravaId: '555' });
    await saveActivities([existing]);
    await saveSession({ session: 'tok-123', athleteId: '999' });
    await mountApp({ resetDb: false });
    // Same startTime + same mmpVersion as the cached row -- activitiesToRefresh
    // should treat this as nothing new to write.
    stubFetch({ activities: [existing] });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('already had everything')) throw new Error('not settled yet');
    });
    expect(await loadActivities()).toHaveLength(1);
  });
});

describe('triggerStravaSync error handling', () => {
  it('on a 401, clears the session, shows a reconnect prompt, and flips the UI back to Connect', async () => {
    await mountConnected();
    stubFetch({ syncSlices: [{ status: 401, body: { error: 'unauthenticated' } }] });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('Strava session expired')) throw new Error('not settled yet');
    });
    expect(document.getElementById('reconnect-strava-btn')).toBeTruthy();
    expect(await loadSession()).toBeNull();
    expect(document.getElementById('strava-connect-btn')).toBeTruthy();
    expect(document.getElementById('strava-sync-btn')).toBeNull();
  });

  it('on a 5xx, shows a calm unavailable message and leaves the session untouched', async () => {
    await mountConnected();
    stubFetch({ syncSlices: [{ status: 503, body: { error: 'strava down' } }] });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('temporarily unavailable')) throw new Error('not settled yet');
    });
    expect(await loadSession()).toEqual({ session: 'tok-123', athleteId: '999' });
    expect(document.getElementById('strava-sync-btn')).toBeTruthy();
  });

  it('surfaces a generic transport error for anything else, and leaves the session untouched', async () => {
    await mountConnected();
    stubFetch({ syncSlices: [{ status: 418, body: { error: 'teapot' } }] });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('Strava sync failed')) throw new Error('not settled yet');
    });
    expect(await loadSession()).toEqual({ session: 'tok-123', athleteId: '999' });
  });
});

describe('Strava connect/disconnect', () => {
  it('Connect shows immediate loading feedback without navigating', async () => {
    // beginStravaConnect defers window.location.assign behind a real
    // setTimeout(60ms). This test only asserts the synchronous click
    // feedback and deliberately doesn't wait for or assert on that
    // deferred call. It's harmless but not preventable: jsdom's
    // Location.assign is non-configurable/non-writable (verified
    // directly -- neither vi.stubGlobal('location', ...) nor a plain
    // property overwrite can intercept it), and fake timers aren't a fix
    // either, since they hang mountApp()'s own IDB-backed vi.waitFor. So
    // the timer fires for real ~60ms later, sometimes mid-way through a
    // *later* test in this file (jsdom's window/location persist across
    // tests within one spec file), producing a benign "Not implemented:
    // navigation to another Document" console warning. It doesn't affect
    // any assertion or leak state -- confirmed by running this file
    // repeatedly -- so it's left as expected noise rather than suppressed.
    await mountApp();
    expect(document.body.dataset.appState).toBe('onboarding');

    const btn = document.getElementById('strava-connect-btn');
    expect(btn).toBeTruthy();
    btn.click();

    expect(btn.disabled).toBe(true);
    expect(btn.classList.contains('is-loading')).toBe(true);
    expect(bannerText()).toContain('Connecting to Strava');
  });

  it('Disconnect clears the session and flips the UI back to Connect', async () => {
    await mountConnected();
    vi.stubGlobal('confirm', () => true);

    document.getElementById('strava-disconnect').click();

    await vi.waitFor(() => {
      if (!document.getElementById('strava-connect-btn')) throw new Error('not settled yet');
    });
    expect(await loadSession()).toBeNull();
    expect(bannerText()).toContain('Disconnected from Strava');
  });

  it('Disconnect does nothing when the confirm prompt is declined', async () => {
    await mountConnected();
    vi.stubGlobal('confirm', () => false);

    document.getElementById('strava-disconnect').click();

    // No async settling to wait for -- handleDisconnect returns
    // synchronously right after the declined confirm(), before any
    // await. A brief real delay confirms nothing changes after the fact.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await loadSession()).toEqual({ session: 'tok-123', athleteId: '999' });
    expect(document.getElementById('strava-sync-btn')).toBeTruthy();
  });
});
