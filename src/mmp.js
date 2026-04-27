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
