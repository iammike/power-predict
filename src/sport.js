// Decide whether a Strava activity is a cycling ride we should feed
// into the power-duration model.
//
// Strava reports activity type in two shapes:
//   - API summaries use camelCase `sport_type` ("VirtualRide",
//     "MountainBikeRide"), with a legacy `type` ("Ride") alongside.
//   - The archive's activities.csv uses spaced words in its
//     "Activity Type" column ("Virtual Ride", "Mountain Bike Ride").
//
// We normalize both to lowercase letters-only and match a ride set, so
// the same predicate serves the sync path and the archive path.
//
// E-bikes are excluded on purpose: motor assistance makes the recorded
// power an unreliable basis for a critical-power model. Runs (including
// running power), walks, hikes, swims, etc. are excluded outright —
// running power in particular is not comparable to cycling power.
const RIDE_TYPES = new Set(['ride', 'virtualride', 'gravelride', 'mountainbikeride']);

export function normalizeType(t) {
  return typeof t === 'string' ? t.toLowerCase().replace(/[^a-z]/g, '') : '';
}

export function isRideType(t) {
  return RIDE_TYPES.has(normalizeType(t));
}

// From a Strava API activity summary: prefer the granular sport_type,
// fall back to the legacy type when sport_type is absent.
export function isRideActivity(a) {
  if (!a) return false;
  return isRideType(a.sport_type || a.type);
}
