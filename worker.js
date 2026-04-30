// Power Predict — Cloudflare Worker
// Handles Strava OAuth, webhook ingest, archive-upload coordination,
// and rate-limit-budgeted Strava API proxying.

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generateRandomToken,
} from './worker/strava-oauth.js';
import {
  resolveSession,
  runSyncSlice,
  loadActivities,
} from './worker/sync.js';

const ALLOWED_ORIGINS = [
  'https://power.iammike.org',
  'https://iammike.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/power-predict\.pages\.dev$/,
  /^https:\/\/[a-z0-9-]+\.power-predict\.pages\.dev$/,
];

function corsOriginFor(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (ALLOWED_ORIGIN_PATTERNS.some(re => re.test(origin))) return origin;
  return null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, init = {}, origin = null) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
      ...(init.headers || {}),
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = corsOriginFor(request);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health check
    if (url.pathname === '/health') {
      return json({ ok: true, service: 'power-predict-api' }, {}, origin);
    }

    // Strava webhook subscription verification (GET) + event delivery (POST)
    if (url.pathname === '/webhook/strava') {
      return handleStravaWebhook(request, env, ctx, url);
    }

    // OAuth: redirect user to Strava authorize
    if (url.pathname === '/auth/strava/authorize') {
      return handleAuthorize(request, env, url);
    }

    // OAuth: exchange code for tokens (called from frontend after redirect)
    if (url.pathname === '/auth/strava/callback') {
      return handleCallback(request, env, origin);
    }

    // Archive-upload signed URL issuance
    if (url.pathname === '/upload/archive') {
      return handleArchiveUpload(request, env, origin);
    }

    // Persist derived MMP data computed in the browser
    if (url.pathname === '/mmp/ingest') {
      return handleMmpIngest(request, env, origin);
    }

    // Strava sync — pull activities + streams, compute MMP server-side.
    if (url.pathname === '/sync/recent') {
      return handleSyncRecent(request, env, origin);
    }

    // Read the synced MMP records back out for the frontend.
    if (url.pathname === '/activities/recent') {
      return handleActivitiesRecent(request, env, origin);
    }

    return json({ error: 'not found' }, { status: 404 }, origin);
  },
};

async function handleStravaWebhook(request, env, ctx, url) {
  // Subscription verification handshake
  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
      return new Response(JSON.stringify({ 'hub.challenge': challenge }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('forbidden', { status: 403 });
  }

  // Event delivery — enqueue and ack quickly; processing happens in waitUntil
  const event = await request.json();
  ctx.waitUntil(processWebhookEvent(event, env));
  return new Response('ok');
}

async function processWebhookEvent(_event, _env) {
  // TODO Phase 4: fetch single activity stream, compute MMP, upsert to D1.
}

async function handleAuthorize(request, env, url) {
  const clientId = env.STRAVA_CLIENT_ID;
  if (!clientId) return new Response('strava client not configured', { status: 503 });
  // The frontend may pass an explicit return path (e.g. '/?after-auth=sync'),
  // so the redirect lands the user back where they started.
  const returnTo = url.searchParams.get('return_to') || '/';
  const state = generateRandomToken();
  // KV holds the state token + intended return path for ten minutes.
  // Strava round-trips the state param back via the callback; we
  // verify there before exchanging the auth code.
  await env.RATE_LIMIT.put(`oauth-state:${state}`, returnTo, { expirationTtl: 600 });
  const callbackUrl = `${url.origin}/auth/strava/callback`;
  const authorize = buildAuthorizeUrl({
    clientId,
    redirectUri: callbackUrl,
    state,
    scope: 'read,activity:read_all',
  });
  return Response.redirect(authorize, 302);
}

async function handleCallback(request, env, origin) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');
  if (err) return redirectToFrontend(env, { error: err });
  if (!code || !state) return new Response('missing code or state', { status: 400 });

  // State must round-trip exactly; consume it (delete) so a leaked
  // state can't be re-used by an attacker.
  const storedReturn = await env.RATE_LIMIT.get(`oauth-state:${state}`);
  if (storedReturn === null) return new Response('invalid or expired state', { status: 400 });
  await env.RATE_LIMIT.delete(`oauth-state:${state}`);

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({
      clientId: env.STRAVA_CLIENT_ID,
      clientSecret: env.STRAVA_CLIENT_SECRET,
      code,
    });
  } catch (e) {
    return redirectToFrontend(env, { error: 'token_exchange_failed', return_to: storedReturn });
  }

  const athleteId = tokens.athlete?.id;
  if (!athleteId) return new Response('strava response missing athlete id', { status: 502 });

  // Upsert the user row. We persist the access + refresh tokens so a
  // later /sync run can talk to Strava on the user's behalf.
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO users (id, display_name, access_token, refresh_token, token_expires_at, created_at, last_sync_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       token_expires_at = excluded.token_expires_at`
  )
    .bind(
      athleteId,
      `${tokens.athlete?.firstname ?? ''} ${tokens.athlete?.lastname ?? ''}`.trim() || null,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expires_at,
      now,
    )
    .run();

  // Issue our own opaque session token. Front-end stores it and uses
  // it on subsequent /sync requests so we don't expose Strava's tokens
  // to the browser. Thirty-day TTL — the user re-auths if they go
  // longer than a month between visits.
  const session = generateRandomToken();
  await env.RATE_LIMIT.put(`session:${session}`, String(athleteId), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  return redirectToFrontend(env, {
    session,
    athlete_id: String(athleteId),
    return_to: storedReturn,
  });
}

// Redirect back to the frontend with auth result encoded in the URL
// hash (so it doesn't hit access logs). Frontend reads the hash on
// load and stores the session token in IndexedDB.
function redirectToFrontend(env, params) {
  const base = env.FRONTEND_URL || 'https://power.iammike.org';
  const returnTo = params.return_to || '/';
  const cleanParams = { ...params };
  delete cleanParams.return_to;
  const hash = new URLSearchParams(cleanParams).toString();
  return Response.redirect(`${base}${returnTo}#${hash}`, 302);
}

function handleArchiveUpload(_request, _env, _origin) {
  // TODO Phase 2: optional R2 staging for very large archives that exceed
  // browser memory. Default path keeps the zip entirely client-side.
  return new Response('not implemented', { status: 501 });
}

function handleMmpIngest(_request, _env, _origin) {
  // TODO Phase 2: validate auth, upsert MMP arrays + activity meta into D1.
  return new Response('not implemented', { status: 501 });
}

// POST /sync/recent
// Body: { session, days?, cursor? }
// Returns the per-slice progress object from runSyncSlice. The
// frontend re-calls until done=true, passing back the prior cursor
// so we don't re-list activities on every slice.
async function handleSyncRecent(request, env, origin) {
  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, { status: 405 }, origin);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, { status: 400 }, origin); }
  const athleteId = await resolveSession(env, body?.session);
  if (!athleteId) return json({ error: 'unauthenticated' }, { status: 401 }, origin);
  try {
    const result = await runSyncSlice({
      env,
      athleteId,
      days: body.days || 180,
      cursor: body.cursor || null,
      knownIds: Array.isArray(body.knownIds) ? body.knownIds : [],
    });
    return json(result, {}, origin);
  } catch (err) {
    return json({ error: err?.message || 'sync failed' }, { status: 500 }, origin);
  }
}

// GET /activities/recent?session=...
// Returns the user's stored activities + per-duration MMP arrays in
// the shape the frontend's IDB cache expects.
async function handleActivitiesRecent(request, env, origin) {
  const url = new URL(request.url);
  const session = url.searchParams.get('session');
  const athleteId = await resolveSession(env, session);
  if (!athleteId) return json({ error: 'unauthenticated' }, { status: 401 }, origin);
  try {
    const activities = await loadActivities(env, athleteId);
    return json({ activities }, {}, origin);
  } catch (err) {
    return json({ error: err?.message || 'load failed' }, { status: 500 }, origin);
  }
}
