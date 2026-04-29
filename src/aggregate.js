// Aggregate per-activity MMP records into a single rolling-best curve.
// Optionally filter by `windowDays` (e.g. 90) so we only consider recent
// activities for the "current fitness" curve.

import { DURATIONS_S } from './mmp.js';

export function rollingBest(activityMmps, {
  windowDays = null,
  now = Date.now(),
  minIF = null,
  ftp = null,
} = {}) {
  const cutoff = windowDays ? now - windowDays * 86400_000 : 0;
  const filterEnabled = Number.isFinite(minIF) && Number.isFinite(ftp) && ftp > 0;
  const best = {};
  for (const { startTime, mmp, avgPower } of activityMmps) {
    if (startTime < cutoff) continue;
    if (filterEnabled && Number.isFinite(avgPower) && avgPower / ftp < minIF) continue;
    for (const d of DURATIONS_S) {
      const v = mmp[d];
      if (typeof v !== 'number') continue;
      if (best[d] === undefined || v > best[d]) best[d] = v;
    }
  }
  return best;
}

// Same selection logic as rollingBest, but also tracks which
// activity owns each per-duration max so the UI can deep-link cells
// to the source ride. Returns { [duration]: { value, stravaId } }.
export function rollingBestWithOwners(activityMmps, {
  windowDays = null,
  now = Date.now(),
  minIF = null,
  ftp = null,
} = {}) {
  const cutoff = windowDays ? now - windowDays * 86400_000 : 0;
  const filterEnabled = Number.isFinite(minIF) && Number.isFinite(ftp) && ftp > 0;
  const best = {};
  for (const a of activityMmps) {
    if (a.startTime < cutoff) continue;
    if (filterEnabled && Number.isFinite(a.avgPower) && a.avgPower / ftp < minIF) continue;
    for (const d of DURATIONS_S) {
      const v = a.mmp?.[d];
      if (typeof v !== 'number') continue;
      if (best[d] === undefined || v > best[d].value) {
        best[d] = { value: v, stravaId: a.stravaId ?? null };
      }
    }
  }
  return best;
}

// Recency-weighted best. For each duration, every activity's MMP is
// scaled by an exponential weight based on age — half-life
// configurable, default 180 days (≈ 6 months) to roughly match
// physiological detraining (5-10% loss per month for trained
// athletes). Shorter half-lives over-penalize older efforts: a
// 60-day-old peak weighted at 42d half-life lands at 37%, but in
// reality a rider's capacity drops only ~20% over 60 days even
// with no training. The activity with the highest WEIGHTED power
// "wins" the duration; we return its RAW power.
//
// Why not return the weighted value? The fit needs realistic watts.
// Weighting selects which effort to trust (a moderate recent ride can
// outrank an old peak), but the prediction should still calibrate
// against actual achieved power.
//
// Effort-quality filter: when `minIF` and `ftp` are supplied, any
// activity whose `avgPower / ftp` ratio falls below `minIF` is
// dropped. This prevents low-effort base rides (zone 2 spinning)
// from anchoring the regression even when they're recent. Activities
// without `avgPower` are included unconditionally (legacy cache,
// re-parse archive to enable filtering on them).
export function recencyWeightedBest(activityMmps, {
  windowDays = null,
  halfLifeDays = 180,
  now = Date.now(),
  minIF = null,
  ftp = null,
} = {}) {
  const cutoff = windowDays ? now - windowDays * 86400_000 : 0;
  const halfLifeMs = halfLifeDays * 86400_000;
  const ln2 = Math.log(2);
  const filterEnabled = Number.isFinite(minIF) && Number.isFinite(ftp) && ftp > 0;
  const winner = {}; // { [duration]: { raw, weighted } }
  for (const { startTime, mmp, avgPower } of activityMmps) {
    if (startTime < cutoff) continue;
    if (filterEnabled && Number.isFinite(avgPower)) {
      const intensity = avgPower / ftp;
      if (intensity < minIF) continue;
    }
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

// Estimate FTP from the all-time best 20-min MMP (Coggan): FTP ≈
// 0.95 × MMP_20min. Falls back to MMP_15min × 0.93 or null if no
// long-duration data is available. Used to compute IF for the
// effort-quality filter.
export function estimateFtp(activityMmps) {
  const best = {};
  for (const { mmp } of activityMmps) {
    for (const d of [1200, 900]) {
      const v = mmp?.[d];
      if (typeof v !== 'number') continue;
      if (best[d] === undefined || v > best[d]) best[d] = v;
    }
  }
  if (best[1200]) return best[1200] * 0.95;
  if (best[900])  return best[900]  * 0.93;
  return null;
}

// Count activities that pass the effort-quality filter, plus those
// excluded vs unknown — for surfacing in the UI so the user knows
// how much data the filter is acting on.
export function effortQualityStats(activityMmps, { minIF, ftp }) {
  let included = 0, excluded = 0, unknown = 0;
  if (!Number.isFinite(minIF) || !Number.isFinite(ftp) || ftp <= 0) {
    return { included: activityMmps.length, excluded: 0, unknown: 0 };
  }
  for (const a of activityMmps) {
    if (!Number.isFinite(a.avgPower)) { unknown++; continue; }
    if (a.avgPower / ftp < minIF) excluded++;
    else included++;
  }
  return { included, excluded, unknown };
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
