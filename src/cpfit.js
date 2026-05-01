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

// 3-parameter (Morton) range can extend further down because the
// pMax term tames the short-end behavior the 2-param hyperbola
// can't represent. Lower bound 30s is a practical floor — below
// that, neuromuscular contributions still dominate.
export const DEFAULT_FIT_RANGE_3P = { minS: 30, maxS: 1200 };

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

// 3-parameter Critical Power (Morton):
//   P(t) = CP + W' / (t + W'/(P_max - CP))
//        = CP + W' / (t + τ),  τ = W'/(P_max - CP)
//
// P_max is the asymptotic short-duration power. The extra
// parameter eliminates the 2-param model's runaway behavior at
// very short durations and lets the fit window extend down to
// roughly 30 seconds.
//
// We fit by searching τ on a dense grid: for each candidate τ,
// the model collapses to a linear regression (P = CP + W' / (t+τ)),
// which we solve in closed form. Across the τ grid we pick the
// one with minimum residual subject to physical sanity bounds:
// CP ∈ [50, 600] W, W' ∈ [1, 60] kJ, P_max ∈ [CP+100, 2500] W.
//
// Falls back to null if no τ in range produces a sane fit. Caller
// is expected to fall back to the 2-param fit in that case.
export function fitCp3(points, range = DEFAULT_FIT_RANGE_3P, opts = {}) {
  const filtered = points.filter(
    (p) => p.durationS >= range.minS && p.durationS <= range.maxS
  );
  if (filtered.length < 3) return null;

  let best = null;
  for (let tau = 1; tau <= 90; tau += 0.5) {
    const fit = fitLinearWithTau(filtered, tau);
    if (!fit) continue;
    if (fit.cpW < 50 || fit.cpW > 600) continue;
    if (fit.wPrimeJ < 1000 || fit.wPrimeJ > 60000) continue;
    if (fit.pMaxW < fit.cpW + 100 || fit.pMaxW > 2500) continue;
    if (!best || fit.sse < best.sse) best = { ...fit, tauS: tau };
  }
  if (!best) return null;

  const n = filtered.length;
  const rmse = Math.sqrt(best.sse / n);

  const observed = (opts.observedPoints || points)
    .filter((p) => Number.isFinite(p.durationS) && Number.isFinite(p.powerW))
    .map((p) => ({ durationS: p.durationS, powerW: p.powerW }))
    .sort((a, b) => a.durationS - b.durationS);
  const longest = observed[observed.length - 1] || null;

  return {
    cpW: best.cpW,
    wPrimeJ: best.wPrimeJ,
    pMaxW: best.pMaxW,
    tauS: best.tauS,
    rmse,
    nPoints: n,
    range,
    minObservedS: filtered.reduce((m, p) => Math.min(m, p.durationS), Infinity),
    maxObservedS: filtered.reduce((m, p) => Math.max(m, p.durationS), -Infinity),
    longestS: longest?.durationS ?? null,
    longestW: longest?.powerW ?? null,
    points: observed,
    model: '3p',
  };
}

function fitLinearWithTau(points, tau) {
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const { durationS, powerW } of points) {
    const x = 1 / (durationS + tau);
    sumX += x;
    sumY += powerW;
    sumXY += x * powerW;
    sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const wPrimeJ = (n * sumXY - sumX * sumY) / denom;
  const cpW = (sumY - wPrimeJ * sumX) / n;
  if (wPrimeJ <= 0) return null;
  const pMaxW = cpW + wPrimeJ / tau;
  let sse = 0;
  for (const { durationS, powerW } of points) {
    const predicted = cpW + wPrimeJ / (durationS + tau);
    sse += (powerW - predicted) ** 2;
  }
  return { cpW, wPrimeJ, pMaxW, sse };
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

// Fit a personal Riegel exponent from MMP points in the long-duration
// range (default 20 min – 4 h). The relation
//   P(t) = P_anchor × (t_anchor / t)^k
// linearizes under log/log to log P = a − k · log t, so a least-squares
// regression on (log t, log P) gives slope = −k.
//
// We require at least three points and clamp k to a physically plausible
// envelope: below ~0.04 implies near-zero fatigue (unrealistic over hours);
// above ~0.20 implies catastrophic decay seen only in untrained or sick
// riders. Outside that window we still report the clamped value with a
// `clamped` flag so callers can distinguish "fitted" from "rail-pinned."
export const DEFAULT_FATIGUE_RANGE = { minS: 1200, maxS: 14400 };
const FATIGUE_K_MIN = 0.04;
const FATIGUE_K_MAX = 0.20;
const FATIGUE_MIN_POINTS = 3;

export function fitFatigueK(points, range = DEFAULT_FATIGUE_RANGE) {
  if (!Array.isArray(points)) return null;
  const filtered = points.filter(
    (p) => p && p.durationS >= range.minS && p.durationS <= range.maxS && p.powerW > 0
  );
  if (filtered.length < FATIGUE_MIN_POINTS) return null;
  const n = filtered.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of filtered) {
    const x = Math.log(p.durationS);
    const y = Math.log(p.powerW);
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom <= 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const kRaw = -slope;
  if (!Number.isFinite(kRaw)) return null;
  const clamped = kRaw < FATIGUE_K_MIN || kRaw > FATIGUE_K_MAX;
  const k = Math.max(FATIGUE_K_MIN, Math.min(FATIGUE_K_MAX, kRaw));
  return { k, kRaw, nPoints: n, clamped };
}

// Baseline P(t) for the fit. 3-param fits include a tauS term;
// 2-param fits don't, and the baseline collapses to CP + W'/t.
function baselinePower(fit, t) {
  const tau = Number.isFinite(fit.tauS) ? fit.tauS : 0;
  return fit.cpW + fit.wPrimeJ / (t + tau);
}

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
  // Manual-mode fits are synthesized from a single number (FTP / CP)
  // and have no observed efforts behind them. Riegel decay only makes
  // physical sense when calibrated against real long-duration rides;
  // applying it on top of a synthesized hyperbola pulls predictions
  // below the user's stated FTP at 60 min, which contradicts the
  // input. Always skip decay for manual fits unless the caller forces
  // an explicit decay opts in.
  const decayDisabled = opts.decay === false || (fit.manual && opts.decay === undefined);
  const decay = decayDisabled ? null : { ...DEFAULT_DECAY, ...(opts.decay || {}) };
  const useObservedAnchors = opts.useObservedAnchors !== false;

  let powerW = baselinePower(fit, durationS);
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
    const thresholdAnchorPower = baselinePower(fit, decay.fromS);
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
        const modelAtP = baselinePower(fit, p.durationS);
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
