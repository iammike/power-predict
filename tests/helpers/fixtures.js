// Shared activityMmps fixture builder for the DOM-wiring integration
// tests (#239). Matches the shape rollingBest/rollingBestWithOwners/
// estimateFtp (src/aggregate.js) and normalizeForDrift (src/drift.js)
// expect, and stays within mmp.js's adjacent-duration anomaly-check
// ratios (src/mmp.js) so fixtures aren't silently stripped.
import { MMP_VERSION } from '../../src/mmp.js';

let nextStartTime = new Date('2026-06-01T12:00:00Z').getTime();

// Durations span the 3-20 min CP fit window (300s, 1200s) plus a short
// and a long point so the table renders more than one row and the fit
// has enough points for both the 2-param and 3-param regressions.
const DEFAULT_MMP = { 60: 420, 300: 340, 1200: 290, 3600: 250 };

export function makeRide({
  startTime = nextStartTime,
  durationS = 3600,
  mmp = DEFAULT_MMP,
  avgPower,
  npW,
  stravaId = null,
  mmpVersion = MMP_VERSION,
} = {}) {
  // Auto-advance so successive makeRide() calls without an explicit
  // startTime don't collide on IDB's startTime primary key.
  nextStartTime += 86_400_000;
  return {
    startTime,
    durationS,
    distanceM: durationS * 8, // ~28.8 km/h, not load-bearing for any assertion
    avgPower,
    npW: npW ?? avgPower,
    mmp,
    mmpVersion,
    stravaId,
  };
}

export function makeRides(count, overrides = {}) {
  return Array.from({ length: count }, () => makeRide(overrides));
}
