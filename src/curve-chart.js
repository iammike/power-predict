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

  // Model: split into two series — CP-validity range (solid) and
  // decay extrapolation (dashed).
  const modelInside = [];
  const modelOutside = [];
  for (const d of SAMPLE_DURATIONS) {
    const inside = d >= fit.range.minS && d <= DEFAULT_DECAY.fromS;
    const out = predictPower(fit, d);
    const w = out ? out.powerW : null;
    modelInside.push(inside ? w : null);
    modelOutside.push(!inside ? w : null);
  }

  // uPlot wants ALL series on the same x axis, so map observed values
  // onto the SAMPLE_DURATIONS grid (null elsewhere).
  const observedAligned = SAMPLE_DURATIONS.map((d) => {
    const idx = observedDurations.indexOf(d);
    return idx >= 0 ? observedPower[idx] : null;
  });
  // If observed durations don't fall on the grid, add them.
  const xs = SAMPLE_DURATIONS.slice();
  for (const d of observedDurations) {
    if (!xs.includes(d)) xs.push(d);
  }
  xs.sort((a, b) => a - b);
  // Re-sample the three series onto the merged xs array.
  const obsSeries = xs.map((d) => {
    const idx = observedDurations.indexOf(d);
    return idx >= 0 ? observedPower[idx] : null;
  });
  const insideSeries = xs.map((d) => {
    const out = (d >= fit.range.minS && d <= DEFAULT_DECAY.fromS)
      ? predictPower(fit, d)
      : null;
    return out ? out.powerW : null;
  });
  const outsideSeries = xs.map((d) => {
    const out = (d > DEFAULT_DECAY.fromS || d < fit.range.minS)
      ? predictPower(fit, d)
      : null;
    return out ? out.powerW : null;
  });

  const data = [xs, obsSeries, insideSeries, outsideSeries];

  const styles = getComputedStyle(document.body);
  const ink = styles.getPropertyValue('--ink').trim() || '#1a1612';
  const oxblood = styles.getPropertyValue('--oxblood').trim() || '#7a1f24';
  const muted = styles.getPropertyValue('--muted').trim() || '#7a6f60';
  const hair = 'rgba(26, 22, 18, 0.18)';

  const opts = {
    width: container.clientWidth || 720,
    height: 360,
    scales: {
      x: { distr: 3, log: 10 }, // log10 scale on duration
      y: { auto: true },
    },
    axes: [
      {
        stroke: ink,
        grid: { stroke: hair, width: 0.5 },
        ticks: { stroke: hair, width: 0.5 },
        font: '11px "JetBrains Mono", ui-monospace, monospace',
        values: (_u, splits) => splits.map(formatDurationTick),
      },
      {
        stroke: ink,
        grid: { stroke: hair, width: 0.5 },
        ticks: { stroke: hair, width: 0.5 },
        font: '11px "JetBrains Mono", ui-monospace, monospace',
        values: (_u, splits) => splits.map((v) => `${Math.round(v)} W`),
      },
    ],
    series: [
      { value: (_u, v) => formatDurationTick(v) },
      {
        label: 'Observed MMP',
        stroke: oxblood,
        fill: oxblood,
        width: 0,
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
      points: { size: 6 },
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
