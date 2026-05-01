// Manual-mode CP/W' synthesis from a rider's FTP (and optional
// 1-min sprint number). For users who haven't uploaded a Strava
// archive but know their FTP — a coarse-but-real prediction beats
// a no-data dead end.
//
// FTP is defined as the 60-minute sustainable power, so the
// synthesis anchors there: the 2-parameter hyperbola P(t) = CP + W'/t
// must return FTP at t = 3600 s. Solving:
//   CP = FTP − W'/3600
// W' from 1-min sprint: solve P(60) = CP + W'/60 = sprint, giving
//   W' = (sprint − CP_seed) × 60 with CP_seed = 0.95 × FTP for a
// stable starting point. Default W' = 18 kJ when no sprint is
// given (middle of the trained-cyclist range, ~15-25 kJ).
//
// Clamps: keep W' in [5 kJ, 40 kJ] so a wildly out-of-range sprint
// number can't produce an absurd hyperbola.
//
// `manual: true` flags downstream code (predictPower, chart) to
// shift the Riegel fatigue anchor from the default 20 min to 60 min.
// Decay still applies for ultra-endurance durations (2 h+), but
// kicks in from the user's stated FTP rather than from a model
// value at 20 min — otherwise the decay would pull 60-min
// predictions below the user's FTP, contradicting the input.

const W_PRIME_DEFAULT_J = 18_000;
const W_PRIME_MIN_J = 5_000;
const W_PRIME_MAX_J = 40_000;

export function synthesizeFit({ ftpW, sprint1minW }) {
  if (!Number.isFinite(ftpW) || ftpW <= 0) return null;

  let wPrimeJ = W_PRIME_DEFAULT_J;
  if (Number.isFinite(sprint1minW) && sprint1minW > 0) {
    const cpSeed = 0.95 * ftpW;
    if (sprint1minW > cpSeed) {
      const fromSprint = (sprint1minW - cpSeed) * 60;
      wPrimeJ = Math.max(W_PRIME_MIN_J, Math.min(W_PRIME_MAX_J, fromSprint));
    }
  }
  // Calibrate CP so the model returns the user's stated FTP at
  // exactly 60 min: CP + W'/3600 = FTP.
  const cpW = ftpW - wPrimeJ / 3600;

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
