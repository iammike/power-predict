# power-predict

Predict the power output you can sustain for a target race duration, based on your Strava history.

**Live target:** [power.iammike.org](https://power.iammike.org/) (not yet deployed)

Patterned after [`sports-card-checklists`](https://github.com/iammike/sports-card-checklists): static SPA on GitHub Pages, Cloudflare Worker for OAuth + API proxy, Cloudflare D1 for storage.

## Why archive upload, not API-only

Strava's free-tier API is shared 200 req / 15 min and 2000 / day across **all users of the app**, plus a single-user cap until you apply for an upgrade. Pulling a power stream costs one request per activity, so onboarding a single user with 500 rides exhausts the daily budget for everyone. Power Predict bulk-onboards from the user's downloaded Strava archive (parsed in the browser) and reserves the API for incremental updates via webhook.

See `~/Documents/claude/power-predict-plan.md` for the full plan.

## Layout

| File | Purpose |
|------|---------|
| `index.html` | Landing + onboarding UI |
| `src/app.js` | Frontend entry — drop-zone wiring, predict form |
| `src/mmp.js` | Mean-maximal-power extraction from a 1Hz power stream |
| `worker.js` | Cloudflare Worker — OAuth, webhook ingest, MMP ingest endpoint |
| `wrangler.toml` | Worker + D1 + R2 + KV bindings |
| `migrations/0001_init.sql` | D1 schema |
| `build.js` | esbuild bundling to `dist/` |
| `tests/` | vitest specs |

## Develop

```bash
npm install
npm run build
npm run serve     # http://localhost:8000
npm test
```

## Deploy

```bash
# one-time
wrangler d1 create power-predict           # then paste id into wrangler.toml
wrangler kv:namespace create RATE_LIMIT
wrangler r2 bucket create power-predict-archives
wrangler d1 execute power-predict --file=migrations/0001_init.sql
wrangler secret put STRAVA_CLIENT_SECRET
wrangler secret put STRAVA_WEBHOOK_VERIFY_TOKEN

# routine
npm run deploy:worker
```

GitHub Pages picks up `index.html` + `dist/` from `main`.

## Strava setup

1. Register an app at https://www.strava.com/settings/api
2. Authorization callback domain: `power.iammike.org`
3. Copy `client_id` into `wrangler.toml` (public) and `client_secret` via `wrangler secret put`
