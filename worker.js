// Power Predict — Cloudflare Worker
// Handles Strava OAuth, webhook ingest, archive-upload coordination,
// and rate-limit-budgeted Strava API proxying.

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

function handleAuthorize(_request, _env, _url) {
  // TODO Phase 4: build Strava authorize URL with state, redirect.
  return new Response('not implemented', { status: 501 });
}

function handleCallback(_request, _env, _origin) {
  // TODO Phase 4: exchange code for tokens via Strava /oauth/token, persist user.
  return new Response('not implemented', { status: 501 });
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
