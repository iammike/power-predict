// MMP (Mean Maximal Power) extraction.
//
// Given a power-vs-time stream sampled at 1 Hz, return the best average
// power for each duration in DURATIONS_S. O(n log n) using a deque-based
// sliding-window max on prefix sums.

export const DURATIONS_S = [
  1, 2, 3, 5, 10, 15, 30, 60, 90, 120, 180, 240, 300,
  360, 480, 600, 720, 900, 1200, 1800, 2700, 3600,
  4500, 5400, 7200, 10800, 14400,
  18000, 21600, 25200, 28800, 32400, 36000, 39600, 43200,
];

// Extraction version. Stamped onto each stored activity so a change to
// the bucket set or extraction logic forces a re-extraction of already-
// stored rides on the next sync (rather than silently serving stale
// MMP rows). Bump this whenever DURATIONS_S or extractMmp changes.
//   v1 — original bucket set capped at 4h
//   v2 — extended to hourly buckets through 12h
export const MMP_VERSION = 2;

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
//
// Only 1-3s are checked, against 5s. The ratios are applied per ride,
// and a ride's best longer-duration value often isn't a maximal effort:
// an isolated sprint or one hard minute in a steady ride (586W 1m vs
// 305W 5m, or 12s at 1000W vs a 520W 30s) is real, not a glitch. A 5s
// window sits inside a short spike or flatline, so the 1-3s/5s checks
// still catch those; a glitch sustained long enough to inflate 5s+ is
// rare enough to leave to manual exclusion (#132).
const ANOMALY_CHECKS = [
  [1, 5, 1.6],
  [2, 5, 1.5],
  [3, 5, 1.4],
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
