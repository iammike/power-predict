import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderCurveChart } from '../src/curve-chart.js';
import { mmpToPoints, fitCp2 } from '../src/cpfit.js';

// Real uPlot needs a canvas rendering context jsdom doesn't provide, and
// this test is about the render/destroy/resize lifecycle, not the chart's
// visual output -- so uPlot itself is faked. The fake tracks exactly what
// #231's bug depended on: constructor calls, and whether destroy()/setSize()
// were called on a given instance.
vi.mock('uplot', () => {
  class FakeUPlot {
    constructor() {
      this.destroyed = false;
      this.setSizeCalls = [];
    }
    setSize(size) {
      this.setSizeCalls.push(size);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { default: FakeUPlot };
});

// jsdom doesn't implement ResizeObserver. The fake exposes the last
// constructed instance's callback so tests can trigger it manually,
// simulating a real resize without needing real layout/timing.
class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb;
    this.observedTargets = [];
    FakeResizeObserver.instances.push(this);
  }
  observe(target) {
    this.observedTargets.push(target);
  }
  disconnect() {}
}
FakeResizeObserver.instances = [];

function makeFit() {
  const mmp = { 60: 420, 300: 340, 1200: 290, 3600: 250 };
  return { mmp, fit: fitCp2(mmpToPoints(mmp)) };
}

describe('renderCurveChart lifecycle (#231)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    FakeResizeObserver.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('destroys the outgoing chart when re-rendered into the same container', () => {
    const container = document.createElement('div');
    const { mmp, fit } = makeFit();

    renderCurveChart(container, { mmp, fit });
    const first = container._chart;
    expect(first).toBeTruthy();
    expect(first.destroyed).toBe(false);

    renderCurveChart(container, { mmp, fit });
    const second = container._chart;

    expect(first.destroyed).toBe(true);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(second.destroyed).toBe(false);
  });

  it('binds exactly one ResizeObserver per container, not one per render', () => {
    const container = document.createElement('div');
    const { mmp, fit } = makeFit();

    renderCurveChart(container, { mmp, fit });
    renderCurveChart(container, { mmp, fit });
    renderCurveChart(container, { mmp, fit });

    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0].observedTargets).toEqual([container]);
  });

  it('resizes whichever chart is current, not a stale reference from the first render', () => {
    // This is the actual #231 regression: before the fix, the resize
    // handler closed over the first chart instance. After a second
    // render ("switching tabs"), a resize needs to reach the *new*
    // chart, not the destroyed old one.
    const container = document.createElement('div');
    const { mmp, fit } = makeFit();

    renderCurveChart(container, { mmp, fit });
    const first = container._chart;

    renderCurveChart(container, { mmp, fit });
    const second = container._chart;

    const observer = FakeResizeObserver.instances[0];
    observer.cb();
    vi.advanceTimersByTime(100);

    expect(second.setSizeCalls.length).toBeGreaterThan(0);
    expect(first.setSizeCalls).toHaveLength(0);
  });

  it('debounces rapid resize notifications into a single setSize call', () => {
    const container = document.createElement('div');
    const { mmp, fit } = makeFit();
    renderCurveChart(container, { mmp, fit });

    const observer = FakeResizeObserver.instances[0];
    observer.cb();
    vi.advanceTimersByTime(30);
    observer.cb();
    vi.advanceTimersByTime(30);
    observer.cb();
    vi.advanceTimersByTime(100);

    expect(container._chart.setSizeCalls).toHaveLength(1);
  });

  it('tolerates being re-rendered with no fit (clears the chart, no throw)', () => {
    const container = document.createElement('div');
    const { mmp, fit } = makeFit();

    renderCurveChart(container, { mmp, fit });
    const first = container._chart;

    expect(() => renderCurveChart(container, { mmp, fit: null })).not.toThrow();
    expect(first.destroyed).toBe(true);
    expect(container._chart).toBeNull();
  });

  it('does nothing when given no container', () => {
    const { mmp, fit } = makeFit();
    expect(() => renderCurveChart(null, { mmp, fit })).not.toThrow();
  });
});
