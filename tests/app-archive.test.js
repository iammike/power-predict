// DOM-wiring integration tests for handleArchive (#239, part 2 of 3 —
// see tests/app-render-flow.test.js for part 1 and its mountApp/fixtures
// harness this reuses). Drives the archive-drop flow through a fake
// Worker (tests/helpers/fakeWorker.js) since jsdom doesn't implement
// Worker at all, and asserts on the same status-banner/IDB/rendered-table
// surface part 1 established as observable from outside app.js's
// unexported functions.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountApp } from './helpers/mountApp.js';
import { FakeWorker } from './helpers/fakeWorker.js';
import { loadActivities } from '../src/storage.js';
import { MMP_VERSION } from '../src/mmp.js';

// Real uPlot needs a canvas rendering context jsdom doesn't provide --
// same reasoning as tests/curve-chart.test.js and tests/app-render-flow.test.js.
// The happy-path test here produces a real currentFit (one activity with
// two in-window MMP points), so renderCurves reaches wireCurveChart, and
// without this mock that would try to construct a real uPlot instance.
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
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  FakeWorker.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function dropFile() {
  const file = new File([new Uint8Array([1, 2, 3])], 'export_1234.zip', { type: 'application/zip' });
  const dropEvt = new Event('drop', { bubbles: true, cancelable: true });
  dropEvt.dataTransfer = { files: [file] };
  document.getElementById('archive-drop').dispatchEvent(dropEvt);
}

async function currentWorker() {
  return vi.waitFor(() => {
    const w = FakeWorker.instances.at(-1);
    if (!w) throw new Error('worker not constructed yet');
    return w;
  });
}

function bannerText() {
  return document.querySelector('.status-banner')?.textContent ?? '';
}

function activityMsg(overrides = {}) {
  return {
    type: 'activity',
    startTime: Date.now() - 10 * 86_400_000,
    durationS: 3600,
    distanceM: 30_000,
    avgPower: 220,
    npW: 230,
    mmp: { 300: 340, 1200: 290 },
    mmpVersion: MMP_VERSION,
    stravaId: null,
    ...overrides,
  };
}

// A real Worker delivers postMessage calls as separate queued tasks, not
// as awaited calls the poster blocks on -- and src/app.js's onmessage
// handler for 'activity' does a real async hasActivity() IDB lookup per
// message. Firing messages here without awaiting each one (unlike an
// earlier version of this file, which serially awaited every onmessage
// call) is what actually exercises that interleaving: handleArchive must
// track in-flight 'activity' handlers and wait for all of them before
// its promise resolves on 'done', or a 'done' that arrives while the
// last activity/activities are still mid-lookup would silently drop
// them. Assertions below poll via vi.waitFor rather than assuming
// synchronous-equivalent completion.
function deliver(worker, ...messages) {
  for (const data of messages) worker.onmessage({ data });
}

describe('handleArchive happy path', () => {
  it('parses activities, persists them to IDB with the full record shape, and renders the results', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();

    const ride1 = activityMsg({ startTime: Date.now() - 10 * 86_400_000 });
    const ride2 = activityMsg({
      startTime: Date.now() - 9 * 86_400_000,
      durationS: 5400,
      distanceM: 40_000,
      avgPower: 200,
      npW: 210,
      mmp: { 300: 300, 1200: 260 },
      stravaId: '99',
    });
    deliver(
      worker,
      { type: 'progress', phase: 'parsing', bytesRead: 10, totalBytes: 100, activitiesSeen: 2, parsedCount: 2, withPower: 2 },
      ride1,
      ride2,
      { type: 'done', failed: 0, failedSamples: [], skippedNonRide: 0 },
    );

    await vi.waitFor(() => {
      if (!document.querySelector('.mmp-table')) throw new Error('not rendered yet');
    });
    expect(worker.terminated).toBe(true);
    expect(bannerText()).toContain('Parsed 2 new activities');
    expect(document.getElementById('results').hidden).toBe(false);

    const saved = await loadActivities();
    expect(saved.map((a) => a.startTime).sort()).toEqual([ride1.startTime, ride2.startTime].sort());
    // Full-record equality, not just startTime/mmp -- npW, durationS,
    // distanceM, mmpVersion, and stravaId all matter downstream
    // (mmpVersion gates re-extraction on a version bump, for instance)
    // and a check on only a couple of fields wouldn't catch one of them
    // getting dropped or miswired.
    const saved2 = saved.find((a) => a.startTime === ride2.startTime);
    expect(saved2).toEqual({
      startTime: ride2.startTime,
      durationS: 5400,
      distanceM: 40_000,
      avgPower: 200,
      npW: 210,
      mmp: { 300: 300, 1200: 260 },
      mmpVersion: MMP_VERSION,
      stravaId: '99',
    });
  });

  it('deduplicates repeated activity messages for the same startTime within one run', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();

    const startTime = Date.now() - 10 * 86_400_000;
    deliver(
      worker,
      activityMsg({ startTime }),
      activityMsg({ startTime, mmp: { 300: 999, 1200: 999 } }), // a duplicate that should be ignored, not overwrite
      { type: 'done', failed: 0, failedSamples: [], skippedNonRide: 0 },
    );

    await vi.waitFor(() => {
      if (!document.querySelector('.mmp-table')) throw new Error('not rendered yet');
    });
    const saved = await loadActivities();
    expect(saved).toHaveLength(1);
    expect(saved[0].mmp).toEqual({ 300: 340, 1200: 290 });
  });

  it('skips (but still counts) an activity already present in IDB from a prior run', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();
    const startTime = Date.now() - 10 * 86_400_000;
    deliver(worker, activityMsg({ startTime }), { type: 'done', failed: 0, failedSamples: [], skippedNonRide: 0 });
    await vi.waitFor(async () => {
      if ((await loadActivities()).length === 0) throw new Error('not saved yet');
    });

    // A second archive drop reports the same ride again -- already in
    // IDB, so it should be recognized and not duplicated or re-saved
    // (src/app.js's hasActivity()-gated skip branch).
    dropFile();
    const worker2 = await vi.waitFor(() => {
      const w = FakeWorker.instances.at(-1);
      if (!w || w === worker) throw new Error('second worker not constructed yet');
      return w;
    });
    deliver(worker2, activityMsg({ startTime }), { type: 'done', failed: 0, failedSamples: [], skippedNonRide: 0 });

    await vi.waitFor(() => {
      if (!bannerText().includes('Parsed 0 new activities')) throw new Error('not settled yet');
    });
    expect(await loadActivities()).toHaveLength(1);
  });

  it('notes skipped non-ride activities alongside the parsed count', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();
    deliver(
      worker,
      activityMsg(),
      { type: 'done', failed: 0, failedSamples: [], skippedNonRide: 3 },
    );

    await vi.waitFor(() => {
      if (!bannerText().includes('Parsed 1 new activities')) throw new Error('not shown yet');
    });
    expect(bannerText()).toContain('skipped 3 non-ride activities');
  });
});

describe('handleArchive with no power-equipped rides', () => {
  it('shows the empty-result message (including the files-seen count) and never renders the results section', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();

    deliver(
      worker,
      { type: 'progress', phase: 'reading', bytesRead: 5, totalBytes: 10, activitiesSeen: 4, parsedCount: 0, withPower: 0 },
      { type: 'done', failed: 0, failedSamples: [], skippedNonRide: 0 },
    );

    await vi.waitFor(() => {
      if (!bannerText().includes('No power-equipped rides found')) throw new Error('not shown yet');
    });
    expect(bannerText()).toContain('4 activity files seen');
    expect(document.getElementById('results').hidden).toBe(true);
    expect(await loadActivities()).toHaveLength(0);
  });
});

describe('handleArchive with unparseable files', () => {
  it('surfaces the failed-file count and sample names alongside anything that did parse', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();

    deliver(
      worker,
      activityMsg(),
      { type: 'done', failed: 2, failedSamples: ['a.fit', 'b.fit'], skippedNonRide: 0 },
    );

    await vi.waitFor(() => {
      if (!bannerText().includes('Skipped 2 files that')) throw new Error('not shown yet');
    });
    expect(bannerText()).toContain('a.fit, b.fit');
    // The one activity that did parse successfully still made it to IDB
    // and rendered -- a parse failure elsewhere shouldn't discard it.
    expect(await loadActivities()).toHaveLength(1);
    expect(document.getElementById('results').hidden).toBe(false);
  });
});

// worker.onmessage is intentionally synchronous now (the fix in this
// PR moved its async work into an unawaited per-message IIFE -- see
// deliver()'s comment) -- so `await worker.onmessage(...)` does NOT wait
// for that IIFE to finish; it resolves immediately since onmessage
// itself returns undefined. Giving the IIFE's own hasActivity() IDB
// lookup a real macrotask to resolve is the only way, from a black-box
// test, to know an 'activity' message has actually landed in
// newActivities before triggering whatever comes next.
async function flushPendingActivity() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('handleArchive worker failure', () => {
  // Both tests deliver and flush a real 'activity' message before
  // failing the worker, so the results-hidden/empty-IDB assertions below
  // prove the error path actually discards in-flight work rather than
  // just observing there was nothing to discard in the first place.
  // Verified: without flushPendingActivity() here, a mutation that saves
  // whatever's in newActivities from inside the catch block survived
  // every test in this describe block, because the error could win the
  // race before the activity handler ever got there.
  it('shows a failure banner, terminates the worker, discards any in-flight activity, and never renders results', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();

    deliver(worker, activityMsg());
    await flushPendingActivity();
    worker.onerror({ message: 'boom' });

    await vi.waitFor(() => {
      if (!bannerText().includes('Archive read failed')) throw new Error('not failed yet');
    });
    expect(bannerText()).toContain('boom');
    expect(worker.terminated).toBe(true);
    expect(document.getElementById('results').hidden).toBe(true);
    expect(await loadActivities()).toHaveLength(0);
  });

  it('also reaches the failure path via an explicit {type: "error"} message', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();

    deliver(worker, activityMsg());
    await flushPendingActivity();
    worker.onmessage({ data: { type: 'error', message: 'parse exploded' } });

    await vi.waitFor(() => {
      if (!bannerText().includes('Archive read failed')) throw new Error('not failed yet');
    });
    expect(bannerText()).toContain('parse exploded');
    expect(worker.terminated).toBe(true);
    expect(document.getElementById('results').hidden).toBe(true);
    expect(await loadActivities()).toHaveLength(0);
  });
});

describe('handleArchive screen wake lock', () => {
  afterEach(() => {
    delete navigator.wakeLock;
  });

  it('holds the wake lock through parsing and only releases it once the worker is done', async () => {
    // jsdom doesn't implement navigator.wakeLock (verified: 'wakeLock' in
    // navigator is false), so handleArchive's wake-lock branch is normally
    // skipped entirely in every other test in this file -- that's the
    // correct default (matches the real no-support case), but the branch
    // itself needs one dedicated test with it stubbed in.
    let released = false;
    const release = vi.fn(async () => { released = true; });
    const request = vi.fn(async () => ({ released: false, release }));
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });

    await mountApp();
    dropFile();
    const worker = await currentWorker();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('screen'));

    deliver(worker, activityMsg());
    await flushPendingActivity();
    // Not released while still mid-parse -- pins the ordering, not just
    // that release() was called at some point (a request-then-immediately
    // -release implementation that defeats the feature would otherwise
    // still satisfy a plain toHaveBeenCalled() check).
    expect(released).toBe(false);

    deliver(worker, { type: 'done', failed: 0, failedSamples: [], skippedNonRide: 0 });
    await vi.waitFor(() => {
      if (!document.querySelector('.mmp-table')) throw new Error('not rendered yet');
    });
    expect(release).toHaveBeenCalled();
  });
});
