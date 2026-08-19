// DOM-wiring integration tests for renderCurves / the override form /
// manual mode / the predict form (#239, part 1 of 3 — see #225 and the
// per-activity-exclude-132 branch for the pure-helper coverage this
// builds on). Mounts real index.html into jsdom and imports a fresh
// src/app.js instance per test via tests/helpers/mountApp.js, then
// drives the same DOM events a real user would.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountApp, resetIndexedDb } from './helpers/mountApp.js';
import { makeRide, makeRides } from './helpers/fixtures.js';
import { saveActivities } from '../src/storage.js';

// Real uPlot needs a canvas rendering context jsdom doesn't provide.
// These tests are about DOM wiring, not the chart's visual output, so
// uPlot itself is faked -- same approach as tests/curve-chart.test.js.
vi.mock('uplot', () => {
  class FakeUPlot {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.setSizeCalls = [];
    }
    setSize(size) { this.setSizeCalls.push(size); }
    destroy() { this.destroyed = true; }
  }
  return { default: FakeUPlot };
});

class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb;
    this.observedTargets = [];
    FakeResizeObserver.instances.push(this);
  }
  observe(target) { this.observedTargets.push(target); }
  disconnect() {}
}
FakeResizeObserver.instances = [];

function submit(form) {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  FakeResizeObserver.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('onboarding vs. data appState', () => {
  it('stays onboarding with an empty cache', async () => {
    await mountApp();
    expect(document.body.dataset.appState).toBe('onboarding');
    expect(document.getElementById('results').hidden).toBe(true);
  });

  it('flips to data and renders the table with a seeded cache', async () => {
    await resetIndexedDb();
    await saveActivities(makeRides(3));
    await mountApp({ resetDb: false });

    expect(document.body.dataset.appState).toBe('data');
    expect(document.getElementById('results').hidden).toBe(false);
    expect(document.querySelector('.mmp-table')).toBeTruthy();
  });
});

describe('predict form (wirePredictForm/renderPredictBlock)', () => {
  beforeEach(async () => {
    await resetIndexedDb();
    await saveActivities(makeRides(3));
    await mountApp({ resetDb: false });
  });

  it('renders a predicted watt value for a parseable duration', () => {
    document.getElementById('predict-input').value = '20m';
    submit(document.getElementById('predict-form'));

    const out = document.getElementById('predict-output');
    expect(out.hidden).toBe(false);
    expect(out.textContent).toMatch(/\d+\s*W/);
    expect(out.textContent).toContain('20m');
  });

  it('shows a parse error for an unparseable duration instead of throwing', () => {
    document.getElementById('predict-input').value = 'nonsense';
    expect(() => submit(document.getElementById('predict-form'))).not.toThrow();

    const out = document.getElementById('predict-output');
    expect(out.hidden).toBe(false);
    expect(out.textContent).toContain("Couldn't parse that");
  });
});

describe('override form round-trip (wireOverrideForm/clearOverrideSettings)', () => {
  beforeEach(async () => {
    await resetIndexedDb();
    await saveActivities(makeRides(3));
    await mountApp({ resetDb: false });
  });

  it('applies a CP override end-to-end through the DOM, then Reset clears it', async () => {
    expect(document.querySelector('.override-badge')).toBeNull();

    document.getElementById('cp-override').value = '300';
    submit(document.getElementById('override-form'));

    // The submit handler awaits saveSettings() before calling
    // renderCurves(), which the dispatchEvent call above doesn't wait
    // for -- poll for the re-rendered OVERRIDE badge.
    await vi.waitFor(() => {
      if (!document.querySelector('.override-badge')) throw new Error('override not applied yet');
    });
    expect(document.getElementById('cp-override').value).toBe('300');

    document.getElementById('reset-override').click();
    await vi.waitFor(() => {
      if (document.querySelector('.override-badge')) throw new Error('override not cleared yet');
    });
    expect(document.getElementById('cp-override').value).toBe('');
  });
});

describe('manual mode (renderManualMode)', () => {
  it('switches to manual state on submit, and "Back to my data" restores the prior render', async () => {
    await resetIndexedDb();
    await saveActivities(makeRides(3));
    await mountApp({ resetDb: false });
    expect(document.body.dataset.appState).toBe('data');

    document.getElementById('manual-unit').value = 'ftp';
    document.getElementById('manual-threshold').value = '280';
    submit(document.getElementById('manual-form'));

    expect(document.body.dataset.appState).toBe('manual');
    expect(document.querySelector('.override-badge')?.textContent).toBe('MANUAL MODE');
    const backBtn = document.getElementById('manual-back');
    expect(backBtn).toBeTruthy();

    backBtn.click();
    expect(document.body.dataset.appState).toBe('data');
    expect(document.querySelector('.mmp-table')).toBeTruthy();
  });

  it('shows no "Back to my data" link when there is no prior activity data', async () => {
    await mountApp();
    expect(document.body.dataset.appState).toBe('onboarding');

    document.getElementById('manual-unit').value = 'ftp';
    document.getElementById('manual-threshold').value = '280';
    submit(document.getElementById('manual-form'));

    expect(document.body.dataset.appState).toBe('manual');
    expect(document.getElementById('manual-back')).toBeNull();
  });
});

describe('curve chart lifecycle across a wireMmpTable-triggered re-render', () => {
  it('destroys exactly the outgoing chart when excluding a ride re-renders the page', async () => {
    await resetIndexedDb();
    await saveActivities(makeRides(3));
    await mountApp({ resetDb: false });

    await vi.waitFor(() => {
      if (!document.getElementById('curve-chart')?._chart) throw new Error('not charted yet');
    });
    const firstChart = document.getElementById('curve-chart')._chart;
    expect(firstChart.destroyed).toBe(false);

    const excludeBtn = document.querySelector('[data-exclude-start]');
    expect(excludeBtn).toBeTruthy();
    excludeBtn.click();

    await vi.waitFor(() => {
      const chart = document.getElementById('curve-chart')?._chart;
      if (!chart || chart === firstChart) throw new Error('not re-rendered yet');
    });
    const secondChart = document.getElementById('curve-chart')._chart;

    expect(firstChart.destroyed).toBe(true);
    expect(secondChart).not.toBe(firstChart);
    expect(secondChart.destroyed).toBe(false);
    // The excluded ride moved into the managed-exclusions panel rather
    // than just vanishing.
    expect(document.querySelector('.exclusions-panel')).toBeTruthy();
  });
});
