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
import { saveActivities, loadActivities, loadSettings } from '../src/storage.js';
import { saveSession, loadSession, API_BASE } from '../src/strava-session.js';
import { MMP_VERSION } from '../src/mmp.js';

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

let restoreLocation = null;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (restoreLocation) restoreLocation();
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Routes by URL substring so a single stub answers both endpoints
// triggerStravaSync drives: syncRecent()'s POST /sync/recent and
// fetchSyncedActivities()'s GET /activities/recent. The happy-path
// sync loop is single-slice here (one POST, `done: true`); the
// multi-slice loop + progress banner get their own gated mock in the
// 'multi-slice sync loop' block below.
function stubFetch({ sync = { processed: 0, remaining: 0, done: true }, syncStatus, activities = [], activitiesStatus = 200 } = {}) {
  const fetchMock = vi.fn(async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/sync/recent')) {
      if (syncStatus) return jsonResponse(syncStatus, { error: 'boom' });
      return jsonResponse(200, sync);
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

// Parsed request bodies of every POST /sync/recent the run made, in
// order — lets a test assert what the client sent (knownIds, cursor).
function syncPostBodies(fetchMock) {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/sync/recent'))
    .map(([, init]) => JSON.parse(init.body));
}

// jsdom's Location.assign has a non-configurable/non-writable own
// descriptor, so vi.spyOn(window.location, 'assign') throws — but the
// `location` property on `window` is itself configurable, so
// defineProperty swaps the whole object for one whose assign is a spy.
// Restored in afterEach so a later test gets the real Location back.
function stubLocationAssign() {
  const original = window.location;
  const assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: original.href, pathname: original.pathname, search: original.search, assign },
  });
  restoreLocation = () => {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    restoreLocation = null;
  };
  return assign;
}

function bannerText() {
  return document.querySelector('.status-banner')?.textContent ?? '';
}

async function mountConnected({ cachedRides = [] } = {}) {
  await resetIndexedDb();
  if (cachedRides.length) await saveActivities(cachedRides);
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
    expect(bannerText()).toContain('1 new ride added');
    expect(document.querySelector('.mmp-table')).toBeTruthy();

    const saved = await loadActivities();
    expect(saved).toHaveLength(1);
    expect(saved[0].startTime).toBe(remoteRide.startTime);
    expect(saved[0].stravaId).toBe('555');
  });

  it('sends only current-mmpVersion Strava ids as knownIds', async () => {
    const current = makeRide({ stravaId: 'current-1' });
    const stale = makeRide({ stravaId: 'stale-1', mmpVersion: 'v0-old' });
    await mountConnected({ cachedRides: [current, stale] });
    const fetchMock = stubFetch({ activities: [current] });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('Sync complete')) throw new Error('not settled yet');
    });
    const bodies = syncPostBodies(fetchMock);
    expect(bodies[0].knownIds).toEqual(['current-1']);
  });

  it('prunes rides the worker reconciled out of D1 from the local cache', async () => {
    const keep = makeRide({ stravaId: 'keep-1' });
    const drop = makeRide({ stravaId: 'drop-1' });
    await mountConnected({ cachedRides: [keep, drop] });
    stubFetch({ sync: { processed: 0, remaining: 0, done: true, removedIds: ['drop-1'] }, activities: [] });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('No power-equipped rides in the synced window')) {
        throw new Error('not settled yet');
      }
    });
    const saved = await loadActivities();
    expect(saved.map((a) => a.stravaId)).toEqual(['keep-1']);
  });

  it('flags cells whose owner changed this sync in settings.lastSyncNewIds', async () => {
    const scale = (mmp, f) => Object.fromEntries(Object.entries(mmp).map(([d, p]) => [d, Math.round(p * f)]));
    const base = { 60: 420, 300: 340, 1200: 290, 3600: 250 };
    const weak = makeRide({ stravaId: 'weak-old', mmp: scale(base, 0.7) });
    await mountConnected({ cachedRides: [weak] });
    const strong = makeRide({ stravaId: 'strong-new', mmp: scale(base, 1.3) });
    stubFetch({ activities: [strong] });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('Sync complete')) throw new Error('not settled yet');
    });
    const settings = await loadSettings();
    expect(settings.lastSyncNewIds).toContain('strong-new');
    expect(settings.lastSyncNewIds).not.toContain('weak-old');
  });

  it('shows a no-rides-in-window message without touching an existing cache', async () => {
    await mountConnected({ cachedRides: makeRides(1) });
    stubFetch({ activities: [] });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('No power-equipped rides in the synced window')) {
        throw new Error('not settled yet');
      }
    });
    expect(await loadActivities()).toHaveLength(1);
  });

  it('reports "already had everything" when the remote set matches the cache', async () => {
    await resetIndexedDb();
    const existing = makeRide({ stravaId: '555' });
    await saveActivities([existing]);
    await saveSession({ session: 'tok-123', athleteId: '999' });
    await mountApp({ resetDb: false });
    // Same startTime + same mmpVersion as the cached row -- activitiesToRefresh
    // treats this as nothing new to write.
    stubFetch({ activities: [existing] });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('already had everything')) throw new Error('not settled yet');
    });
    expect(await loadActivities()).toHaveLength(1);
  });
});

describe('triggerStravaSync multi-slice sync loop', () => {
  it('threads the cursor across slices and shows per-slice progress in the banner', async () => {
    await mountConnected();

    let releaseSecondSlice;
    const secondSliceGate = new Promise((resolve) => { releaseSecondSlice = resolve; });
    const fetchMock = vi.fn(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('/sync/recent')) {
        const body = JSON.parse(init.body);
        if (!body.cursor) {
          return jsonResponse(200, { processed: 2, totalWithPower: 5, remaining: 3, done: false, cursor: { tag: 'c1' } });
        }
        await secondSliceGate;
        return jsonResponse(200, { processed: 3, totalWithPower: 5, remaining: 0, done: true });
      }
      if (urlStr.includes('/activities/recent')) return jsonResponse(200, { activities: [] });
      throw new Error(`unexpected URL ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    document.getElementById('strava-sync-btn').click();

    // Paused at the second slice's gate: the first slice's onProgress
    // has run, so the banner shows cumulative 2 / 5 with 3 remaining.
    await vi.waitFor(() => {
      if (!bannerText().includes('2 / 5')) throw new Error('first slice progress not shown yet');
    });
    expect(bannerText()).toContain('3 remaining');

    releaseSecondSlice();

    await vi.waitFor(() => {
      if (!bannerText().includes('No power-equipped rides in the synced window')) {
        throw new Error('not settled yet');
      }
    });
    const bodies = syncPostBodies(fetchMock);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].cursor).toBeNull();
    expect(bodies[1].cursor).toEqual({ tag: 'c1' });
  });
});

describe('triggerStravaSync error handling', () => {
  it('on a 401, clears the session, shows a reconnect prompt, and flips the UI back to Connect', async () => {
    await mountConnected();
    stubFetch({ syncStatus: 401 });

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
    stubFetch({ syncStatus: 503 });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('temporarily unavailable')) throw new Error('not settled yet');
    });
    expect(await loadSession()).toEqual({ session: 'tok-123', athleteId: '999' });
    expect(document.getElementById('strava-sync-btn')).toBeTruthy();
  });

  it('surfaces a generic transport error for anything else, and leaves the session untouched', async () => {
    await mountConnected();
    stubFetch({ syncStatus: 418 });

    document.getElementById('strava-sync-btn').click();

    await vi.waitFor(() => {
      if (!bannerText().includes('Strava sync failed')) throw new Error('not settled yet');
    });
    expect(await loadSession()).toEqual({ session: 'tok-123', athleteId: '999' });
  });
});

describe('Strava connect/disconnect', () => {
  it('Connect shows loading feedback and navigates to the authorize URL', async () => {
    const assign = stubLocationAssign();
    await mountApp();
    expect(document.body.dataset.appState).toBe('onboarding');

    const btn = document.getElementById('strava-connect-btn');
    expect(btn).toBeTruthy();
    btn.click();

    expect(btn.disabled).toBe(true);
    expect(btn.classList.contains('is-loading')).toBe(true);
    expect(bannerText()).toContain('Connecting to Strava');

    // beginStravaConnect defers the redirect behind a 60ms setTimeout.
    await vi.waitFor(() => {
      if (!assign.mock.calls.length) throw new Error('redirect not fired yet');
    });
    const target = assign.mock.calls[0][0];
    expect(target).toContain(`${API_BASE}/auth/strava/authorize`);
    expect(target).toContain('return_to=%2F');
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

    // handleDisconnect returns synchronously at the declined confirm(),
    // before any await, so there is no async settling to wait for.
    document.getElementById('strava-disconnect').click();

    expect(await loadSession()).toEqual({ session: 'tok-123', athleteId: '999' });
    expect(document.getElementById('strava-sync-btn')).toBeTruthy();
  });
});
