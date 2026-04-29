# power-predict

Predict the wattage you can sustain for a target race duration, based on your Strava history.

**Live:** [power.iammike.org](https://power.iammike.org/)

A static SPA on GitHub Pages with a Web Worker that parses your Strava archive in-browser. No upload — your power streams never leave your machine. Cloudflare Worker + D1 are scaffolded for the (planned) OAuth + webhook sync path; they're not required for the archive-upload onboarding that ships today.

## How it works

1. Request your Strava archive (Settings → My Account → Download Request — full guide at `docs/strava-archive-guide.html`).
2. Drop the zip on the page. A Web Worker unzips it, parses every FIT file, and computes mean-maximal-power arrays per activity.
3. Derived data is cached in IndexedDB so returning visits are instant. Only the per-activity MMP arrays persist; raw streams are discarded after parsing.
4. The fit + predict + chart all run client-side from that cache.

No archive yet? The landing page also has a **manual mode** that synthesizes a coarse CP/W' from a rider-entered FTP (and optional 1-min sprint), so you can kick the tires without paying the archive-upload cost.

## Modeling

- **MMP per activity** — best rolling-average power at every duration from 1 s up to 4 h.
- **Anomaly filter** — adjacent-duration ratio sanity checks drop power-meter spikes (a single 2000 W sample) and flatlines (a 2 s plateau at 1367 W) from each activity's MMP before it feeds rolling-best.
- **Effort-quality filter** — activities below 70 % of estimated FTP (≈ 0.95 × all-time best 20-min MMP) are dropped from the regression input so zone-2 base rides don't anchor the fit.
- **Rolling-best aggregation** — Last 30 d / Last 90 d / All-time. Within a 90-day window, peak power is what the rider has demonstrated they can do — no recency weighting on top.
- **2-parameter Critical Power model** — `P(t) = CP + W'/t`, fitted in the standard 3–20 minute window by ordinary least squares.
- **Fitness-drift normalization** — when the 90-day window is sparse and the fit falls back to all-time, each activity's MMP is rescaled by `eFTP_now / eFTP_then` (clamped to [0.7, 1.3]) so a years-old peak doesn't anchor today's prediction.
- **Riegel-style fatigue decay** beyond the fit window with k = 0.10. Anchored on whichever observed effort closest to the target exceeds the model — predictions are grounded in real data, not just the regression's asymptote.
- **Manual fit override** — pin CP to a value you trust, or restrict the fit to a date range. Persists in IndexedDB.

Full methodology + references at `docs/methodology.html` (Skiba, Allen & Coggan, Riegel 1981, Monod & Scherrer 1965, Hill 1925).

## Layout

| File | Purpose |
|------|---------|
| `index.html` | Landing + onboarding UI (drop zone, manual-mode panel) |
| `src/app.js` | Drop-zone wiring, render loop, predict / manual / override forms |
| `src/archive-worker.js` | Web Worker entry — file slicing, fflate Unzip, FIT parse, MMP extraction, activities.csv → activity-ID map |
| `src/mmp.js` | MMP extraction from a 1 Hz power stream + per-activity anomaly filter |
| `src/aggregate.js` | Rolling-best aggregation, FTP estimation, effort-quality stats |
| `src/drift.js` | eFTP timeline + fitness-drift rescaling |
| `src/cpfit.js` | 2-parameter CP regression + Riegel decay extrapolation |
| `src/manual.js` | FTP-only CP/W' synthesis for no-archive mode |
| `src/curve-chart.js` | uPlot-based power-duration curve |
| `src/storage.js` | IndexedDB cache (activities + settings) |
| `worker.js` | Cloudflare Worker — OAuth, webhook ingest (Phase 4, not yet wired) |
| `migrations/0001_init.sql` | D1 schema (Phase 4) |

## Develop

```bash
npm install
npm run build       # bundle app, worker, css
npm run serve       # http://localhost:8000
npm test            # vitest, 72 unit tests across 8 suites
```

## Deploy

GitHub Pages serves `index.html` + `dist/` from `main`. The deploy workflow runs tests, builds, and publishes on every push.

The Cloudflare Worker is wired but unused until Phase 4 ships:

```bash
wrangler d1 create power-predict
wrangler kv:namespace create RATE_LIMIT
wrangler r2 bucket create power-predict-archives
wrangler d1 execute power-predict --file=migrations/0001_init.sql
wrangler secret put STRAVA_CLIENT_SECRET
wrangler secret put STRAVA_WEBHOOK_VERIFY_TOKEN
```

## Roadmap

Open issues are grouped by phase: see [milestones](https://github.com/iammike/power-predict/milestones). Highlights still queued:

- **Phase 3 (modeling)** — 3-parameter CP fit with P_max (#12), training-load adjustment via CTL/ATL/TSB (#42)
- **Phase 4 (sync)** — Strava OAuth + webhook ingest (#20, #21), 180-day API backfill (#39), rate-limit budget (#22), connect UI (#26)
- **Phase 5 (polish)** — privacy / accessibility / account deletion, robust FIT error recovery (#29), TCX/GPX support (#8)

## Strava setup (for Phase 4)

1. Register an app at https://www.strava.com/settings/api
2. Authorization callback domain: `power.iammike.org`
3. Copy `client_id` into `wrangler.toml` (public), `client_secret` via `wrangler secret put`
