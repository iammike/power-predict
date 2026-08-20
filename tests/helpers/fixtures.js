// Shared activityMmps fixture builder for the DOM-wiring integration
// tests (#239). Matches the shape rollingBest/rollingBestWithOwners/
// estimateFtp (src/aggregate.js) and normalizeForDrift (src/drift.js)
// expect, and stays within mmp.js's adjacent-duration anomaly-check
// ratios (src/mmp.js) so fixtures aren't silently stripped.
import { MMP_VERSION } from '../../src/mmp.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// Anchored relative to Date.now(), not a hardcoded calendar date --
// rollingBest/rollingBestWithOwners/computeLoadSeries all window off
// Date.now() (src/aggregate.js), so a fixed past date drifts out of the
// Last-30d/90d windows (and eventually the CP fit's 90-day window) as
// real time passes, silently flipping which fit branch a test exercises
// with no assertion failing to signal it.
//
// The per-ride spacing is hourly, not daily: rideIndex is module-scoped
// and accumulates across every test in a file (vi.resetModules() inside
// mountApp() doesn't reset it -- this file's own static import binding
// survives), so a whole test file's fixture rides share one counter. At
// an hourly spacing from a 10-day-back base, the Last-30d boundary
// (aggregate.js's earliest, most conservative window) isn't reached
// until ride #480 in a single file -- comfortably beyond what any
// realistic test file creates.
let rideIndex = 0;

// Durations span the 3-20 min CP fit window (300s, 1200s) plus a short
// and a long point so the table renders more than one row. This shape
// fits cleanly via the 2-param regression -- the 3-param (Morton) fit's
// tau grid search rejects it (the 3-point exact solution here lands
// tau ~168s, outside the model's [1,90] trained-cyclist grid), so
// currentFit.model stays 2-param for every test built on this default.
// Tests that specifically need the 3-param branch should shape their own
// mmp rather than rely on this default reaching it.
const DEFAULT_MMP = { 60: 420, 300: 340, 1200: 290, 3600: 250 };

export function makeRide({
  startTime,
  durationS = 3600,
  mmp = DEFAULT_MMP,
  // Real records (src/archive-worker.js) always carry a finite avgPower,
  // and since durationS's own window IS the whole ride, avgPower must
  // equal mmp[durationS] -- no other value is reachable from a real
  // parse. Defaulting to that (rather than undefined, or an unrelated
  // constant) keeps the effort-quality gate (passesEffortGate) and the
  // training-load pipeline (computeTss) exercised the way they are in
  // production, instead of either silently no-op'ing or exercising an
  // IF ratio a real archive could never produce.
  avgPower = mmp?.[durationS] ?? 220,
  npW,
  stravaId = null,
  mmpVersion = MMP_VERSION,
} = {}) {
  const resolvedStartTime = startTime ?? (Date.now() - 10 * DAY_MS - rideIndex * HOUR_MS);
  rideIndex += 1;
  return {
    startTime: resolvedStartTime,
    durationS,
    distanceM: durationS * 8, // ~28.8 km/h, not load-bearing for any assertion
    avgPower,
    npW: npW ?? avgPower,
    mmp,
    mmpVersion,
    stravaId,
  };
}

// `overrides` may be a plain object (applied identically to every ride --
// fine as long as it doesn't pin an explicit startTime, since activities
// are keyed by startTime in IDB and identical values collapse to one row)
// or a function `(index) => overrides` for rides that need to differ.
export function makeRides(count, overrides = {}) {
  const overridesFor = typeof overrides === 'function' ? overrides : () => overrides;
  return Array.from({ length: count }, (_, i) => makeRide(overridesFor(i)));
}
