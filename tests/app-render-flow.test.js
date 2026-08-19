// DOM-wiring integration tests for renderCurves / the override form /
// manual mode / the predict form (#239, part 1 of 3 — see #225 for the
// pure-helper coverage this builds on, and #132 for the exclude/restore
// feature and the currentActivities/currentActivitiesRaw split a couple
// of these tests specifically guard). Mounts real index.html into jsdom
// and imports a fresh src/app.js instance per test via
// tests/helpers/mountApp.js, then drives the same DOM events a real
// user would.
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
    }
    setSize() {}
    destroy() { this.destroyed = true; }
  }
  return { default: FakeUPlot };
});

// jsdom doesn't implement ResizeObserver; renderCurveChart's dependency
// chain constructs one unconditionally. Nothing here drives a resize, so
// the fake only needs to exist, not do anything.
class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

function submit(form) {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

// A specific column (0=Duration, 1=Last30d, 2=Last90d/featured,
// 3=All-time) of whichever table row's Duration cell matches the given
// formatDuration() label.
function cellFor(durationLabel, columnIndex) {
  for (const row of document.querySelectorAll('.mmp-table tbody tr')) {
    if (row.children[0]?.textContent === durationLabel) return row.children[columnIndex];
  }
  return null;
}

// The Last-90d column -- the one both the table's featured display and
// the CP fit itself read (src/app.js's `last90`).
function featuredCellFor(durationLabel) {
  return cellFor(durationLabel, 2);
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
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
    expect(out.textContent).toContain('20m');
    // The default fixture's mmp has exactly two points (300s, 1200s) in
    // the 2-param fit's window, so the regression is an exact fit through
    // both -- the prediction at 1200s (a fit point, not extrapolated)
    // should reproduce its 290W input exactly, not just "some number."
    expect(out.textContent).toMatch(/\b290W\b/);
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

  // renderManualMode snapshots currentActivitiesRaw (the complete set),
  // not currentActivities (the exclusion-filtered view) -- src/app.js's
  // own comment on that line says a previously-excluded ride would have
  // nothing to restore from after a manual-mode round trip otherwise.
  // Excluding a ride before entering manual mode, then coming back, is
  // the one scenario where snapshotting the wrong array is observable.
  it('preserves an exclusion made before entering manual mode, across the round trip', async () => {
    await resetIndexedDb();
    await saveActivities(makeRides(3));
    await mountApp({ resetDb: false });

    document.querySelector('[data-exclude-start]').click();
    await vi.waitFor(() => {
      if (!document.querySelector('.exclusions-panel [data-restore-start]')) {
        throw new Error('exclusion not applied yet');
      }
    });

    document.getElementById('manual-unit').value = 'ftp';
    document.getElementById('manual-threshold').value = '280';
    submit(document.getElementById('manual-form'));
    expect(document.body.dataset.appState).toBe('manual');

    document.getElementById('manual-back').click();
    expect(document.body.dataset.appState).toBe('data');
    // Snapshotting the filtered view instead of the raw one would bring
    // back a 2-ride set with nothing to restore from -- the panel would
    // render empty or disappear entirely.
    expect(document.querySelectorAll('.exclusions-panel [data-restore-start]')).toHaveLength(1);
  });
});

describe('excluding a ride (wireMmpTable)', () => {
  // Two rides where the second strictly out-powers the first at every
  // duration, so it wins every table cell by construction -- excluding
  // it has an observable, exact-value effect instead of a same-looking
  // table with one fewer cached ride behind it. avgPower is left at
  // fixtures.js's default (mmp[durationS], i.e. 250W/290W here) rather
  // than overridden -- comfortably clear of the effort-quality gate
  // either way (IF 0.80-0.93 against either ride's own ~276-314W
  // estimated FTP), so no override is needed to keep this test's
  // result away from that gate's boundary.
  const LOWER_MMP = { 60: 420, 300: 340, 1200: 290, 3600: 250 };
  const HIGHER_MMP = { 60: 460, 300: 380, 1200: 330, 3600: 290 };

  it('drops the displayed value and destroys exactly the outgoing chart; Restore brings both back', async () => {
    await resetIndexedDb();
    await saveActivities([
      makeRide({ mmp: LOWER_MMP }),
      makeRide({ mmp: HIGHER_MMP }),
    ]);
    await mountApp({ resetDb: false });

    expect(featuredCellFor('20m').textContent).toMatch(/\b330 W\b/);
    // Not just the featured (Last-90d) column -- a regression confined
    // to the all-time rollingBest* call sites should fail here too.
    expect(cellFor('20m', 3).textContent).toMatch(/\b330 W\b/);
    await vi.waitFor(() => {
      if (!document.getElementById('curve-chart')?._chart) throw new Error('not charted yet');
    });
    const firstChart = document.getElementById('curve-chart')._chart;
    expect(firstChart.destroyed).toBe(false);

    // The 20m/Last-90d cell's exclude button belongs to whichever ride
    // owns that cell -- the higher-power ride, by construction above.
    const excludeBtn = featuredCellFor('20m').querySelector('[data-exclude-start]');
    expect(excludeBtn).toBeTruthy();
    excludeBtn.click();

    await vi.waitFor(() => {
      if (!/\b290 W\b/.test(featuredCellFor('20m')?.textContent ?? '')) throw new Error('not excluded yet');
    });
    expect(cellFor('20m', 3).textContent).toMatch(/\b290 W\b/);
    const secondChart = document.getElementById('curve-chart')._chart;
    expect(firstChart.destroyed).toBe(true);
    expect(secondChart).not.toBe(firstChart);
    expect(secondChart.destroyed).toBe(false);

    document.querySelector('.exclusions-panel [data-restore-start]').click();
    await vi.waitFor(() => {
      if (!/\b330 W\b/.test(featuredCellFor('20m')?.textContent ?? '')) throw new Error('not restored yet');
    });
    const thirdChart = document.getElementById('curve-chart')._chart;
    expect(secondChart.destroyed).toBe(true);
    expect(thirdChart).not.toBe(secondChart);
    expect(thirdChart.destroyed).toBe(false);
    expect(document.querySelectorAll('.exclusions-panel [data-restore-start]')).toHaveLength(0);
  });
});
