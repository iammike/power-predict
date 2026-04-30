// Power-duration curve chart. Renders observed MMP points + the fitted
// CP curve + the fatigue-decay tail in a single plot, log-scaled on
// the duration axis.

import uPlot from 'uplot';
import { DEFAULT_DECAY, predictPower } from './cpfit.js';

const SAMPLE_DURATIONS = (() => {
  // Dense log-spaced samples 1s..24h for the model and decay lines.
  const out = [];
  const min = 1;
  const max = 86400;
  const steps = 240;
  const r = Math.log(max / min);
  for (let i = 0; i <= steps; i++) {
    out.push(Math.round(min * Math.exp((r * i) / steps)));
  }
  return Array.from(new Set(out));
})();

// Standard cycling power-profile anchor durations from Allen/Coggan
// (Training and Racing with a Power Meter). 5s = sprint, 1m =
// anaerobic capacity, 5m = VO2max, 20m = threshold, 60m = sub-
// threshold; longer durations follow common ultra reference points.
const STANDARD_TICKS = [
  1,                       // 1s
  15,                      // 15s
  60,                      // 1m
  300,                     // 5m
  1200,                    // 20m
  3600,                    // 1h
  7200,                    // 2h
  14400,                   // 4h
  28800,                   // 8h
  43200,                   // 12h
  86400,                   // 24h
];

export function renderCurveChart(container, { mmp, fit }) {
  if (!container) return;
  container.innerHTML = '';
  if (!fit) {
    container.innerHTML = '<p class="results-foot__note">Need a fit before plotting the curve.</p>';
    return;
  }

  // Observed: MMP map → sorted by duration.
  const observedDurations = Object.keys(mmp || {})
    .map(Number)
    .filter((d) => Number.isFinite(d) && Number.isFinite(mmp[d]))
    .sort((a, b) => a - b);
  const observedPower = observedDurations.map((d) => mmp[d]);

  // Merge SAMPLE_DURATIONS with observed durations so observed points
  // land on the same x grid as the model lines.
  const xs = SAMPLE_DURATIONS.slice();
  for (const d of observedDurations) if (!xs.includes(d)) xs.push(d);
  xs.sort((a, b) => a - b);

  // Build three series:
  //   - obsSeries: observed MMP at recorded durations (else null)
  //   - insideSeries: CP fit only inside the fitting window (3-20 min)
  //   - outsideSeries: decay extrapolation only beyond the fitting
  //     window's CEILING (decay.fromS = 1200 s). We intentionally do
  //     NOT extrapolate below the fitting window — the 2-parameter CP
  //     model gives nonsensical kilowatt values at sub-minute
  //     durations (CP + W'/1s ≈ 22 kW), which would dominate the
  //     y-axis and make the chart unreadable.
  const obsSeries = xs.map((d) => {
    const idx = observedDurations.indexOf(d);
    return idx >= 0 ? observedPower[idx] : null;
  });
  // The chart line is the smooth regression + threshold-anchored
  // decay (no observed-anchor envelope) so it reads as a clean
  // power-duration curve, not a sawtooth that spikes at every
  // observed dot. The predict form still uses the envelope, so
  // single-duration predictions remain anchored to real rides.
  // Solid inside the fit window, dashed outside; both series share
  // d == DEFAULT_DECAY.fromS so the visual transition is seamless.
  const lineOpts = { useObservedAnchors: false };
  if (fit.fatigue) lineOpts.decay = { k: fit.fatigue.k };
  const insideSeries = xs.map((d) => {
    if (d < fit.range.minS || d > DEFAULT_DECAY.fromS) return null;
    const out = predictPower(fit, d, lineOpts);
    return out ? out.powerW : null;
  });
  const outsideSeries = xs.map((d) => {
    if (d < DEFAULT_DECAY.fromS) return null;
    const out = predictPower(fit, d, lineOpts);
    return out ? out.powerW : null;
  });

  const data = [xs, obsSeries, insideSeries, outsideSeries];

  // Y-axis range: anchor at 0, top at the observed max with 10%
  // headroom. Falls back to the threshold-anchored model power when
  // there's no observed data yet (keeps the axis sensible).
  const observedMax = observedPower.length ? Math.max(...observedPower) : null;
  const modelTop = (() => {
    const at = predictPower(fit, fit.range.minS);
    return at ? at.powerW : 400;
  })();
  const yMax = Math.ceil(((observedMax ?? modelTop) * 1.1) / 50) * 50;

  const styles = getComputedStyle(document.body);
  const ink = styles.getPropertyValue('--ink').trim() || '#1a1612';
  const oxblood = styles.getPropertyValue('--oxblood').trim() || '#7a1f24';
  const muted = styles.getPropertyValue('--muted').trim() || '#7a6f60';
  const hair = 'rgba(26, 22, 18, 0.18)';

  const opts = {
    width: container.clientWidth || 720,
    height: 360,
    padding: [16, 16, 8, 8],
    scales: {
      x: { distr: 3, log: 10 },          // log10 scale on duration
      y: { auto: false, range: [0, yMax] },
    },
    axes: [
      {
        stroke: ink,
        grid: { stroke: hair, width: 0.5 },
        ticks: { stroke: hair, width: 0.5 },
        font: '11px "JetBrains Mono", ui-monospace, monospace',
        size: 28,
        splits: () => STANDARD_TICKS,
        values: (_u, splits) => splits.map(formatDurationTick),
      },
      {
        stroke: ink,
        grid: { stroke: hair, width: 0.5 },
        ticks: { stroke: hair, width: 0.5 },
        font: '11px "JetBrains Mono", ui-monospace, monospace',
        size: 56,                        // fits "1500 W" without clipping
        values: (_u, splits) => splits.map((v) => `${Math.round(v)} W`),
      },
    ],
    series: [
      { value: (_u, v) => formatDurationTick(v) },
      {
        label: 'Observed MMP',
        stroke: oxblood,
        width: 0,
        spanGaps: false,
        points: { show: true, size: 6, stroke: oxblood, fill: oxblood },
        value: (_u, v) => (v == null ? '—' : `${Math.round(v)} W`),
      },
      {
        label: 'CP fit (3-20 min)',
        stroke: ink,
        width: 1.5,
        points: { show: false },
        value: (_u, v) => (v == null ? '—' : `${Math.round(v)} W`),
      },
      {
        label: 'Extrapolation',
        stroke: muted,
        width: 1.25,
        dash: [4, 4],
        points: { show: false },
        value: (_u, v) => (v == null ? '—' : `${Math.round(v)} W`),
      },
    ],
    cursor: {
      drag: { x: false, y: false },
      x: true,
      y: true,
      points: { size: 6 },
      // Snap the crosshair x to whatever data column is closest in
      // pixel space, then read y values off each series for the live
      // legend. (uPlot does this by default; declared here so future
      // changes don't accidentally lose the hover readout.)
      focus: { prox: 24 },
    },
    legend: {
      show: true,
      live: true,
    },
  };

  const chart = new uPlot(opts, data, container);
  // Resize on window changes
  if (!container.dataset.resizeBound) {
    container.dataset.resizeBound = '1';
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        chart.setSize({ width: container.clientWidth, height: 360 });
      }, 80);
    });
  }
}

function formatDurationTick(s) {
  if (s == null) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) {
    const h = s / 3600;
    return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`;
  }
  return `${Math.round(s / 3600)}h`;
}
