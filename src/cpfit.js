// 2-parameter Critical Power model.
//
// P(t) = CP + W'/t
//
// CP (W) is the asymptote — the power you could theoretically hold
// indefinitely. W' (J) is the finite work above CP you can do before
// exhausting that anaerobic reserve.
//
// We fit by linear regression on the hyperbolic form: with x = 1/t
// and y = P, the model becomes y = W' * x + CP — slope is W',
// intercept is CP.
//
// Standard CP fitting window is 3-20 minutes. Below 3 min, anaerobic
// contribution distorts the fit; above 20 min, fatigue effects pull
// the curve below the simple hyperbola.

export const DEFAULT_FIT_RANGE = { minS: 180, maxS: 1200 };

// Convert an MMP map ({60: 350, 300: 280, ...}) to an array of points.
export function mmpToPoints(mmp) {
  const out = [];
  for (const [d, p] of Object.entries(mmp)) {
    const durationS = Number(d);
    if (Number.isFinite(durationS) && Number.isFinite(p)) {
      out.push({ durationS, powerW: p });
    }
  }
  return out;
}

// Linear-regression fit. Returns null if there aren't at least 2
// points within the fitting window.
export function fitCp2(points, range = DEFAULT_FIT_RANGE) {
  const filtered = points.filter(
    (p) => p.durationS >= range.minS && p.durationS <= range.maxS
  );
  if (filtered.length < 2) return null;

  const n = filtered.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const { durationS, powerW } of filtered) {
    const x = 1 / durationS;
    sumX += x;
    sumY += powerW;
    sumXY += x * powerW;
    sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const wPrimeJ = (n * sumXY - sumX * sumY) / denom;
  const cpW = (sumY - wPrimeJ * sumX) / n;

  let sse = 0;
  for (const { durationS, powerW } of filtered) {
    const predicted = cpW + wPrimeJ / durationS;
    sse += (powerW - predicted) ** 2;
  }
  const rmse = Math.sqrt(sse / n);

  // Track the longest-duration MMP across the *full* input (not just
  // the fitting window) so predictions for endurance durations can
  // anchor to real data instead of extrapolating from the CP model.
  let longest = null;
  for (const p of points) {
    if (!Number.isFinite(p.durationS) || !Number.isFinite(p.powerW)) continue;
    if (!longest || p.durationS > longest.durationS) longest = p;
  }

  return {
    cpW,
    wPrimeJ,
    rmse,
    nPoints: n,
    range,
    minObservedS: filtered.reduce((m, p) => Math.min(m, p.durationS), Infinity),
    maxObservedS: filtered.reduce((m, p) => Math.max(m, p.durationS), -Infinity),
    longestS: longest?.durationS ?? null,
    longestW: longest?.powerW ?? null,
  };
}

// Riegel-style fatigue decay applied beyond the CP-validity window.
//   P(t) = P_anchor × (t_anchor / t)^k
//
// Empirically, single-k Riegel underpredicts decay for ultra-endurance
// durations. Skiba publishes k = 0.07 for cycling, which matches Coggan
// well in the 1-4h range; beyond that, observed pro/amateur profiles
// fall off faster, more like k ≈ 0.10. Default is 0.10 here so 12h+
// predictions land in the 65-75% CP range observed in practice.
//
// When a longer-duration MMP point exists in the user's data than the
// fitting window's ceiling, predictPower anchors the decay at *that
// observed power and duration* rather than the model-extrapolated
// value at 1200s. This grounds endurance predictions in real data.
//
// References:
//   - Riegel, "Athletic Records and Human Endurance" (1981)
//   - Skiba, Scientific Training for Endurance Athletes
//   - Allen & Coggan, Training and Racing with a Power Meter
//   - Pinot & Grappe, "The Record Power Profile" (2011)
export const DEFAULT_DECAY = {
  fromS: 1200,  // top of standard CP fitting window (20 min)
  k: 0.10,
};

// Predict sustainable power for a target duration.
// Returns { powerW, low, high, extrapolated, fit, decayed } or null.
//
// Pass `opts.decay = false` to disable fatigue decay (raw 2-param CP);
// pass `opts.decay = { fromS, k }` to override.
//
// The confidence band is the fit RMSE plus an extrapolation penalty
// that grows logarithmically with how far the target sits outside
// the observed MMP range.
export function predictPower(fit, durationS, opts = {}) {
  if (!fit || !Number.isFinite(durationS) || durationS <= 0) return null;
  const decay = opts.decay === false ? null : { ...DEFAULT_DECAY, ...(opts.decay || {}) };

  let powerW = fit.cpW + fit.wPrimeJ / durationS;
  let decayed = false;
  if (decay && durationS > decay.fromS) {
    // Prefer to anchor at the longest observed MMP when it's beyond
    // the fitting window — real data beats the model extrapolation.
    let anchorS = decay.fromS;
    let anchorPower = fit.cpW + fit.wPrimeJ / decay.fromS;
    if (
      fit.longestS && fit.longestW &&
      fit.longestS > decay.fromS &&
      fit.longestS <= durationS
    ) {
      anchorS = fit.longestS;
      anchorPower = fit.longestW;
    }
    powerW = anchorPower * (anchorS / durationS) ** decay.k;
    decayed = true;
  }

  let extrapolated = false;
  let extrapolationPenalty = 0;
  if (durationS < fit.minObservedS) {
    extrapolated = true;
    extrapolationPenalty = Math.log(fit.minObservedS / durationS) * 8;
  } else if (durationS > fit.maxObservedS) {
    extrapolated = true;
    extrapolationPenalty = Math.log(durationS / fit.maxObservedS) * 8;
  }

  const halfBand = fit.rmse + extrapolationPenalty;
  return {
    powerW,
    low: powerW - halfBand,
    high: powerW + halfBand,
    extrapolated,
    decayed,
    fit,
  };
}
