// Strava OAuth helpers, kept separate from the Worker entry so they
// can be unit-tested without booting Miniflare. The handlers in
// worker.js wire these into KV / D1 state and the request lifecycle.

const STRAVA_AUTHORIZE = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN = 'https://www.strava.com/oauth/token';

// Build the redirect URL we send the user to when they click
// "Connect Strava." Strava round-trips state back to our callback
// so we can defeat CSRF and resume a frontend return path.
export function buildAuthorizeUrl({ clientId, redirectUri, state, scope }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope,
    state,
  });
  return `${STRAVA_AUTHORIZE}?${params.toString()}`;
}

// Exchange the short-lived auth code for a long-lived refresh token
// and a six-hour access token. Strava's response also includes the
// athlete profile, which we use to seed the users row.
export async function exchangeCodeForTokens(
  { clientId, clientSecret, code },
  fetchImpl = fetch,
) {
  if (!clientId || !clientSecret) {
    throw new Error('strava credentials missing');
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
  });
  const res = await fetchImpl(STRAVA_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`strava token exchange failed: ${res.status} ${text}`);
  }
  return res.json();
}

// Refresh a near-expiry access token. Strava treats the refresh
// endpoint identically to the initial exchange, just with a different
// grant_type. Returns the same shape minus the athlete profile.
export async function refreshTokens(
  { clientId, clientSecret, refreshToken },
  fetchImpl = fetch,
) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetchImpl(STRAVA_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`strava token refresh failed: ${res.status} ${text}`);
  }
  return res.json();
}

// 256-bit random token, base64url-encoded. Used for OAuth state and
// for our opaque session tokens. Falls back gracefully if the
// runtime hasn't exposed crypto.getRandomValues (very old environments).
export function generateRandomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
