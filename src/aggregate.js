// Aggregate per-activity MMP records into a single rolling-best curve.
// Optionally filter by `windowDays` (e.g. 90) so we only consider recent
// activities for the "current fitness" curve.

import { DURATIONS_S } from './mmp.js';

export function rollingBest(activityMmps, { windowDays = null, now = Date.now() } = {}) {
  const cutoff = windowDays ? now - windowDays * 86400_000 : 0;
  const best = {};
  for (const { startTime, mmp } of activityMmps) {
    if (startTime < cutoff) continue;
    for (const d of DURATIONS_S) {
      const v = mmp[d];
      if (typeof v !== 'number') continue;
      if (best[d] === undefined || v > best[d]) best[d] = v;
    }
  }
  return best;
}

// Average power for a stream segment (used for normalized power below).
function rollingAverage(stream, windowSize) {
  if (stream.length < windowSize) return new Float32Array();
  const out = new Float32Array(stream.length - windowSize + 1);
  let sum = 0;
  for (let i = 0; i < windowSize; i++) sum += stream[i];
  out[0] = sum / windowSize;
  for (let i = windowSize; i < stream.length; i++) {
    sum += stream[i] - stream[i - windowSize];
    out[i - windowSize + 1] = sum / windowSize;
  }
  return out;
}

// Normalized Power (Coggan): 4th-root of mean of (30s rolling avg)^4.
export function normalizedPower(stream) {
  if (!stream || stream.length < 30) return null;
  const avg30 = rollingAverage(stream, 30);
  if (avg30.length === 0) return null;
  let sum4 = 0;
  for (let i = 0; i < avg30.length; i++) sum4 += avg30[i] ** 4;
  return Math.pow(sum4 / avg30.length, 0.25);
}

export function avgPower(stream) {
  if (!stream || stream.length === 0) return null;
  let s = 0;
  for (let i = 0; i < stream.length; i++) s += stream[i];
  return s / stream.length;
}
