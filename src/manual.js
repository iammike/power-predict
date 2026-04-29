// Manual-mode CP/W' synthesis from a rider's FTP (and optional
// 1-min sprint number). For users who haven't uploaded a Strava
// archive but know their FTP — a coarse-but-real prediction beats
// a no-data dead end.
//
// CP ≈ 0.95 × FTP (Coggan: FTP ≈ 60-min power ≈ ~1.05 × CP).
// W' from 1-min sprint: solve the 2-param hyperbola P(60) = CP + W'/60
//   → W' = (P_1min - CP) × 60.
// Default W' = 18 kJ when no sprint number is given (middle of the
// trained-cyclist range, ~15-25 kJ).
//
// Clamps: keep W' in [5 kJ, 40 kJ] so a wildly out-of-range sprint
// number can't produce an absurd hyperbola.

const W_PRIME_DEFAULT_J = 18_000;
const W_PRIME_MIN_J = 5_000;
const W_PRIME_MAX_J = 40_000;

export function synthesizeFit({ ftpW, sprint1minW }) {
  if (!Number.isFinite(ftpW) || ftpW <= 0) return null;
  const cpW = ftpW * 0.95;

  let wPrimeJ = W_PRIME_DEFAULT_J;
  if (Number.isFinite(sprint1minW) && sprint1minW > cpW) {
    const fromSprint = (sprint1minW - cpW) * 60;
    wPrimeJ = Math.max(W_PRIME_MIN_J, Math.min(W_PRIME_MAX_J, fromSprint));
  }

  return {
    cpW,
    wPrimeJ,
    rmse: 0,
    nPoints: 0,
    fallback: false,
    overridden: false,
    manual: true,
  };
}
