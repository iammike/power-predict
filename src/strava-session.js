// Strava OAuth session helpers, run on the frontend.
//
// On page load we check the URL hash for a session token + athlete_id
// dropped there by the worker callback. If present we persist them in
// IDB settings and scrub the hash so reload doesn't re-trigger.
//
// The worker's hostname lives in API_BASE. It's a constant for now;
// move to a build-time var if/when we run a staging worker too.

import { loadSettings, saveSettings } from './storage.js';

export const API_BASE = 'https://power-predict-api.iammikec.workers.dev';

// Read window.location.hash, return { session, athleteId, error }
// when any auth params are present. Caller decides what to do —
// success path stores them; error path surfaces to the user.
export function parseAuthHash(hash) {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const session = params.get('session');
  const athleteId = params.get('athlete_id');
  const error = params.get('error');
  if (!session && !athleteId && !error) return null;
  return { session, athleteId, error };
}

// Drain the auth hash from the URL (history-replace, so we don't add
// a back-button entry) so a refresh doesn't re-run the persist path.
export function clearAuthHash() {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const url = `${location.pathname}${location.search}`;
  history.replaceState(null, '', url);
}

// Hydrate the in-memory session from IDB settings.
export async function loadSession() {
  const s = await loadSettings();
  if (s?.stravaSession && s?.stravaAthleteId) {
    return { session: s.stravaSession, athleteId: s.stravaAthleteId };
  }
  return null;
}

export async function saveSession({ session, athleteId }) {
  const s = (await loadSettings()) || {};
  await saveSettings({ ...s, stravaSession: session, stravaAthleteId: athleteId });
}

export async function clearSession() {
  const s = (await loadSettings()) || {};
  delete s.stravaSession;
  delete s.stravaAthleteId;
  await saveSettings(s);
}

// Build the redirect URL the Connect button sends the user to.
// returnTo is the path to land on after auth (default '/').
export function authorizeUrl(returnTo = '/') {
  const params = new URLSearchParams({ return_to: returnTo });
  return `${API_BASE}/auth/strava/authorize?${params.toString()}`;
}

// Drive the multi-call sync loop. `onProgress` is invoked after each
// slice with the cumulative counts; resolves when done. Throws on
// transport errors so the caller can surface them.
export async function syncRecent({ session, days = 180, onProgress }) {
  let cursor = null;
  let cumulativeProcessed = 0;
  while (true) {
    const res = await fetch(`${API_BASE}/sync/recent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, days, cursor }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`sync failed: ${res.status} ${text}`);
    }
    const slice = await res.json();
    cumulativeProcessed += slice.processed || 0;
    onProgress?.({
      processed: cumulativeProcessed,
      totalWithPower: slice.totalWithPower,
      remaining: slice.remaining,
      errors: slice.errors,
    });
    if (slice.done) return { processed: cumulativeProcessed, totalWithPower: slice.totalWithPower };
    cursor = slice.cursor;
  }
}

// Pull the synced activities + MMP arrays out of the worker so the
// frontend can drop them into IDB and render the same way archive
// uploads do.
export async function fetchSyncedActivities(session) {
  const res = await fetch(`${API_BASE}/activities/recent?session=${encodeURIComponent(session)}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`activities load failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  return body.activities || [];
}
