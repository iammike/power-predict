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
// `points` drives the regression. `opts.observedPoints` (defaults to
// `points`) is what predictPower scans when anchoring decay on real
// efforts — pass the raw rolling-best here when the regression input
// is recency-weighted, so a real ride from 50 days ago can still
// keep predictions honest at long durations.
export function fitCp2(points, range = DEFAULT_FIT_RANGE, opts = {}) {
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

  // Keep the observed-point set on the fit so predictPower can
  // anchor decay on whichever real effort is most relevant for the
  // target duration. Defaults to the regression points but can be
  // supplied separately so the regression can use recency-weighted
  // values while anchoring still trusts raw rolling-best efforts.
  const observed = (opts.observedPoints || points)
    .filter((p) => Number.isFinite(p.durationS) && Number.isFinite(p.powerW))
    .map((p) => ({ durationS: p.durationS, powerW: p.powerW }))
    .sort((a, b) => a.durationS - b.durationS);
  const longest = observed[observed.length - 1] || null;

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
    points: observed,
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
// Options:
//   `decay`              - false to disable fatigue decay; `{ fromS, k }` to override
//   `useObservedAnchors` - default true. When false, predictions follow the
//                          regression + threshold-anchored Riegel decay only,
//                          without lifting the line to match observations.
//                          The chart uses this for a smooth visualization;
//                          the predict form keeps the default so single-
//                          duration predictions never undercut a real ride.
export function predictPower(fit, durationS, opts = {}) {
  if (!fit || !Number.isFinite(durationS) || durationS <= 0) return null;
  const decay = opts.decay === false ? null : { ...DEFAULT_DECAY, ...(opts.decay || {}) };
  const useObservedAnchors = opts.useObservedAnchors !== false;

  let powerW = fit.cpW + fit.wPrimeJ / durationS;
  let decayed = false;
  // Apply the observed-anchor envelope at *all* durations so the
  // chart line is continuous across the fit-window boundary. Inside
  // the fit window the baseline is the regression model itself; the
  // envelope only lifts it where a longer-duration observed effort
  // implies you can do at least as much for the shorter duration.
  if (decay) {
    // Inside the fit window the baseline is the model itself.
    // Outside, the threshold-anchored decay takes over (model at the
    // top of the fit window, then Riegel from there).
    const thresholdAnchorPower = fit.cpW + fit.wPrimeJ / decay.fromS;
    let best = durationS > decay.fromS
      ? thresholdAnchorPower * (decay.fromS / durationS) ** decay.k
      : powerW;

    if (useObservedAnchors && Array.isArray(fit.points)) {
      // Every observed point above the model contributes a Riegel
      // decay curve valid at *all* extrapolation durations. We take
      // the upper envelope, regardless of whether the anchor sits
      // before or after the target — that's what makes the curve
      // continuous across observation boundaries. (For target < anchor,
      // the formula gives a slightly higher power, which matches the
      // physical intuition: if you held P for 30 min, you held ≥ P
      // for any shorter duration of the same effort.)
      // Anchor candidates are observations beyond the fit window
      // whose power exceeds what the regression predicts at their
      // duration. (Anchors inside the fit window are already encoded
      // in CP/W'.)
      for (const p of fit.points) {
        if (p.durationS <= decay.fromS) continue;
        const modelAtP = fit.cpW + fit.wPrimeJ / p.durationS;
        if (p.powerW <= modelAtP) continue;
        const fromP = p.powerW * (p.durationS / durationS) ** decay.k;
        if (fromP > best) best = fromP;
      }

      // Final safeguard: never predict below a recorded MMP at the
      // exact target duration.
      const exact = fit.points.find((p) => p.durationS === durationS);
      if (exact && exact.powerW > best) best = exact.powerW;
    }

    powerW = best;
    decayed = durationS > decay.fromS;
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
