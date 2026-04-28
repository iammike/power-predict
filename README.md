# power-predict

Predict the wattage you can sustain for a target race duration, based on your Strava history.

**Live:** [power.iammike.org](https://power.iammike.org/)

A static SPA on GitHub Pages with a Web Worker that parses your Strava archive in-browser. No upload — your power streams never leave your machine. Cloudflare Worker + D1 are scaffolded for the (planned) OAuth + webhook sync path; they're not required for the archive-upload onboarding that ships today.

## How it works

1. Request your Strava archive (Settings → My Account → Download Request — full guide at `docs/strava-archive-guide.md`).
2. Drop the zip on the page. A Web Worker unzips it, parses every FIT file, and computes mean-maximal-power arrays per activity.
3. Derived data is cached in IndexedDB so returning visits are instant. Only the per-activity MMP arrays persist; raw streams are discarded after parsing.
4. The fit + predict + chart all run client-side from that cache.

## Modeling

- **MMP per activity** — best rolling-average power for every duration (1 s up to 4 h).
- **Rolling-best aggregation** — Last 30d / Last 90d / All-time. The display table shows raw rolling-best across the window.
- **Recency-weighted regression** — the CP fit consumes a 42-day half-life weighted aggregation, so a 60-day-old peak counts ≈ 37% of a recent ride. Keeps the fit responsive to current form.
- **2-parameter Critical Power model** — `P(t) = CP + W'/t`, fitted in the standard 3–20 minute window by ordinary least squares.
- **Riegel-style fatigue decay** beyond the fit window with k = 0.10. Anchored on whichever observed effort closest to the target exceeds the model — predictions are grounded in real data, not just the regression's asymptote.
- **Manual override** — set a custom CP or restrict the fit to a date range. Persists in IndexedDB.

Full methodology + references at `docs/methodology.html` (Skiba, Allen & Coggan, Riegel 1981, Pinot & Grappe, Monod & Scherrer 1965).

## Layout

| File | Purpose |
|------|---------|
| `index.html` | Landing + onboarding UI |
| `src/app.js` | Drop-zone wiring, render loop, predict + override forms |
| `src/archive-worker.js` | Web Worker entry — file slicing, fflate Unzip, FIT parse, MMP extraction |
| `src/mmp.js` | Mean-maximal-power extraction from a 1 Hz power stream |
| `src/aggregate.js` | Rolling-best + recency-weighted MMP aggregation |
| `src/cpfit.js` | 2-parameter CP regression + Riegel decay extrapolation |
| `src/curve-chart.js` | uPlot-based power-duration curve |
| `src/storage.js` | IndexedDB cache (activities + settings) |
| `worker.js` | Cloudflare Worker — OAuth, webhook ingest (Phase 4, not yet wired) |
| `migrations/0001_init.sql` | D1 schema (Phase 4) |

## Develop

```bash
npm install
npm run build       # bundle app, worker, css
npm run serve       # http://localhost:8000
npm test            # vitest, ~37 unit tests
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

- **Phase 3** — effort-quality flagging (#18), training-load nudge (#42), eFTP normalization (#17), distance/speed helper (#14)
- **Phase 4** — Strava OAuth + webhook ingest (#20, #21), 180-day API backfill (#39), rate-limit budget (#22), connect UI (#26)
- **Phase 5** — privacy / accessibility / account deletion polish

## Strava setup (for Phase 4)

1. Register an app at https://www.strava.com/settings/api
2. Authorization callback domain: `power.iammike.org`
3. Copy `client_id` into `wrangler.toml` (public), `client_secret` via `wrangler secret put`
