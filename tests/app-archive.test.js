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

describe('handleArchive happy path', () => {
  it('parses one activity, persists it to IDB, and renders the results', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();

    await worker.onmessage({
      data: {
        type: 'progress', phase: 'parsing', bytesRead: 10, totalBytes: 100,
        activitiesSeen: 1, parsedCount: 1, withPower: 1,
      },
    });
    const startTime = Date.now() - 10 * 86_400_000;
    await worker.onmessage({
      data: {
        type: 'activity', startTime, durationS: 3600, distanceM: 30_000,
        avgPower: 220, npW: 230, mmp: { 300: 340, 1200: 290 },
        mmpVersion: MMP_VERSION, stravaId: null,
      },
    });
    await worker.onmessage({ data: { type: 'done', failed: 0, failedSamples: [], skippedNonRide: 0 } });

    await vi.waitFor(() => {
      if (!document.querySelector('.mmp-table')) throw new Error('not rendered yet');
    });
    expect(worker.terminated).toBe(true);
    expect(bannerText()).toContain('Parsed 1 new activities');
    expect(document.getElementById('results').hidden).toBe(false);

    const saved = await loadActivities();
    expect(saved).toHaveLength(1);
    expect(saved[0].startTime).toBe(startTime);
    expect(saved[0].mmp).toEqual({ 300: 340, 1200: 290 });
  });
});

describe('handleArchive with no power-equipped rides', () => {
  it('shows the empty-result message and never renders the results section', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();

    await worker.onmessage({ data: { type: 'done', failed: 0, failedSamples: [], skippedNonRide: 0 } });

    await vi.waitFor(() => {
      if (!bannerText().includes('No power-equipped rides found')) throw new Error('not shown yet');
    });
    expect(document.getElementById('results').hidden).toBe(true);
    expect(await loadActivities()).toHaveLength(0);
  });
});

describe('handleArchive with unparseable files', () => {
  it('surfaces the failed-file count and sample names alongside anything that did parse', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();

    await worker.onmessage({
      data: {
        type: 'activity', startTime: Date.now() - 5 * 86_400_000, durationS: 3600,
        distanceM: 30_000, avgPower: 220, npW: 230, mmp: { 300: 340, 1200: 290 },
        mmpVersion: MMP_VERSION, stravaId: null,
      },
    });
    await worker.onmessage({
      data: { type: 'done', failed: 2, failedSamples: ['a.fit', 'b.fit'], skippedNonRide: 0 },
    });

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

describe('handleArchive worker failure', () => {
  it('shows a failure banner, terminates the worker, and never renders results', async () => {
    await mountApp();
    dropFile();
    const worker = await currentWorker();

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

    await worker.onmessage({ data: { type: 'error', message: 'parse exploded' } });

    await vi.waitFor(() => {
      if (!bannerText().includes('Archive read failed')) throw new Error('not failed yet');
    });
    expect(bannerText()).toContain('parse exploded');
    expect(worker.terminated).toBe(true);
  });
});

describe('handleArchive screen wake lock', () => {
  afterEach(() => {
    delete navigator.wakeLock;
  });

  it('requests a wake lock during parsing and releases it when done, when the API is available', async () => {
    // jsdom doesn't implement navigator.wakeLock (verified: 'wakeLock' in
    // navigator is false), so handleArchive's wake-lock branch is normally
    // skipped entirely in every other test in this file -- that's the
    // correct default (matches the real no-support case), but the branch
    // itself needs one dedicated test with it stubbed in.
    const release = vi.fn(async () => {});
    const request = vi.fn(async () => ({ released: false, release }));
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });

    await mountApp();
    dropFile();
    const worker = await currentWorker();
    await worker.onmessage({
      data: {
        type: 'activity', startTime: Date.now() - 5 * 86_400_000, durationS: 3600,
        distanceM: 30_000, avgPower: 220, npW: 230, mmp: { 300: 340, 1200: 290 },
        mmpVersion: MMP_VERSION, stravaId: null,
      },
    });
    await worker.onmessage({ data: { type: 'done', failed: 0, failedSamples: [], skippedNonRide: 0 } });

    await vi.waitFor(() => {
      if (!document.querySelector('.mmp-table')) throw new Error('not rendered yet');
    });
    expect(request).toHaveBeenCalledWith('screen');
    expect(release).toHaveBeenCalled();
  });
});
