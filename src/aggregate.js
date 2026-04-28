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

// Recency-weighted best. For each duration, every activity's MMP is
// scaled by an exponential weight based on age — half-life
// configurable, default 42 days (6 weeks). The activity with the
// highest WEIGHTED power "wins" the duration; we return its RAW power.
//
// Why not return the weighted value? The fit needs realistic watts.
// Weighting selects which effort to trust (a moderate recent ride can
// outrank an old peak), but the prediction should still calibrate
// against actual achieved power.
//
// Inside `windowDays`, this gives the CP fit a curve that responds to
// current form: a 6-week-old super-effort no longer dominates if more
// recent rides tell a different story.
export function recencyWeightedBest(activityMmps, {
  windowDays = null,
  halfLifeDays = 42,
  now = Date.now(),
} = {}) {
  const cutoff = windowDays ? now - windowDays * 86400_000 : 0;
  const halfLifeMs = halfLifeDays * 86400_000;
  const ln2 = Math.log(2);
  const winner = {}; // { [duration]: { raw, weighted } }
  for (const { startTime, mmp } of activityMmps) {
    if (startTime < cutoff) continue;
    const ageMs = Math.max(0, now - startTime);
    const weight = Math.exp((-ln2 * ageMs) / halfLifeMs);
    for (const d of DURATIONS_S) {
      const v = mmp[d];
      if (typeof v !== 'number') continue;
      const weighted = v * weight;
      if (winner[d] === undefined || weighted > winner[d].weighted) {
        winner[d] = { raw: v, weighted };
      }
    }
  }
  const out = {};
  for (const d of Object.keys(winner)) out[d] = winner[d].raw;
  return out;
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
