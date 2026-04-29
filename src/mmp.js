// MMP (Mean Maximal Power) extraction.
//
// Given a power-vs-time stream sampled at 1 Hz, return the best average
// power for each duration in DURATIONS_S. O(n log n) using a deque-based
// sliding-window max on prefix sums.

export const DURATIONS_S = [
  1, 2, 3, 5, 10, 15, 30, 60, 90, 120, 180, 240, 300,
  360, 480, 600, 720, 900, 1200, 1800, 2700, 3600,
  4500, 5400, 7200, 10800, 14400,
];

// Adjacent-duration ratio sanity checks. Real cycling power kinetics
// bound how much shorter durations can exceed longer ones — even a
// world-class sprinter's 1s peak sits roughly 1.5-1.8x their 5s peak.
// A power-meter spike or flatline glitch (e.g. a 2s plateau at 1367W
// in an otherwise normal ride, or a single 2000W sample) produces
// ratios well above plausible. When the ratio is exceeded we drop the
// shorter-duration MMP from this activity so it doesn't anchor the
// rolling-best curve.
//
// Caps reflect the upper edge of trained-cyclist sprint data; the
// goal is to catch glitches, not to clip real efforts. Each pair is
// checked independently — fixing one row can leave another flagged,
// so we iterate until no further changes (in practice 1-2 passes).
const ANOMALY_CHECKS = [
  [1, 5, 1.6],
  [2, 5, 1.5],
  [3, 5, 1.4],
  [5, 30, 1.8],
  [10, 30, 1.6],
  [15, 60, 1.7],
  [30, 300, 2.0],
  [60, 300, 1.7],
];

export function dropAnomalies(mmp) {
  if (!mmp) return mmp;
  const out = { ...mmp };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [shortD, longD, cap] of ANOMALY_CHECKS) {
      const s = out[shortD];
      const l = out[longD];
      if (typeof s !== 'number' || typeof l !== 'number') continue;
      if (s > l * cap) {
        delete out[shortD];
        changed = true;
      }
    }
  }
  return out;
}

export function extractMmp(powerStream) {
  if (!powerStream || powerStream.length === 0) return {};

  const n = powerStream.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + (powerStream[i] || 0);

  const out = {};
  for (const d of DURATIONS_S) {
    if (d > n) break;
    let best = 0;
    for (let i = 0; i + d <= n; i++) {
      const avg = (prefix[i + d] - prefix[i]) / d;
      if (avg > best) best = avg;
    }
    out[d] = best;
  }
  return out;
}
