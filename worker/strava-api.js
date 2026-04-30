// Strava API client — listing activities and fetching power streams.
// Pure functions parameterized by an access token + fetch impl so the
// callers in worker.js can wire env-derived state and the unit tests
// can swap in a stub fetch.

const STRAVA_API = 'https://www.strava.com/api/v3';

// List activities the athlete recorded after `afterEpoch` (unix s).
// Strava paginates per_page (max 200). We page until an empty page or
// the requested cap is reached.
export async function listActivitiesAfter(
  { accessToken, afterEpoch, perPage = 200, maxPages = 5 },
  fetchImpl = fetch,
) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${STRAVA_API}/athlete/activities?after=${afterEpoch}&per_page=${perPage}&page=${page}`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`strava list activities ${res.status}: ${text}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < perPage) break;
  }
  return out;
}

// Pull the watts stream for an activity. Returns the dense Number[]
// at the activity's recording resolution (typically 1 Hz). Returns
// null when the activity has no power recording.
export async function fetchPowerStream(
  { accessToken, activityId },
  fetchImpl = fetch,
) {
  const url = `${STRAVA_API}/activities/${activityId}/streams?keys=watts&key_by_type=true`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`strava streams ${activityId} ${res.status}: ${text}`);
  }
  const body = await res.json();
  const watts = body?.watts?.data;
  if (!Array.isArray(watts) || watts.length === 0) return null;
  return watts;
}

// Quick power-equipped check from an activity summary. Strava sets
// `device_watts: true` for power-meter rides; `average_watts` exists
// for both real and estimated power, so we lean on device_watts.
export function hasRealPower(activity) {
  return Boolean(activity && activity.device_watts === true);
}
