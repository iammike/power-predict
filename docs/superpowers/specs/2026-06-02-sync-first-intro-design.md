# Sync-first intro — design

## Problem

The landing page's "How it works" steps lead with **01 / Request — Ask Strava
for your archive**, framing the offline archive download (prepared over hours,
emailed as a link) as the primary way in. Syncing only appears as a step-03
afterthought ("Connect Strava later so new rides flow in automatically").

This is misleading. Syncing is the faster path, needs no download or waiting,
and pulls the recent rides the prediction weights most heavily. The product
already supports sync as a first-class entry point — `refreshStravaUi()` runs
on load (`src/app.js:91`) and renders a Connect panel with "Sync the last 180
days from your Strava account — no archive download required." Only the intro
copy and visual order lag behind, steering people toward the slower path.

## Goal

Reframe the intro so connecting and syncing Strava is the recommended primary
path, and the archive download is presented as an optional way to extend with
full history. The change is copy + layout only; no prediction/model logic is
touched.

## Design

### 1. Steps copy (`index.html`)

Rewrite the three steps from archive-first to sync-first:

| | Now | Proposed |
|---|---|---|
| 01 | **Request** — Ask Strava for your archive. They prepare it offline and email a link within hours. | **Connect** — Connect your Strava. Authorize once and we sync your last 180 days. No download, no waiting. |
| 02 | **Drop** — Drag the zip onto the page. Parsed in your browser. Raw streams never leave your machine. | **Read** — See your power-duration curve. Recent rides weighted heaviest, so it reflects current fitness. |
| 03 | **Read** — See your power-duration curve. Connect Strava later so new rides flow in automatically. | **Extend** *(optional)* — Want your full history? Download your Strava archive and drop the zip in. Parsed in your browser; raw streams never leave your machine. [Step-by-step](docs/strava-archive-guide.html) |

The privacy point ("parsed in your browser / raw streams never leave your
machine") moves onto the new archive/extend step so it is not lost. Editorial
voice (terse `NN / Word` step labels, italic serif headings) is preserved.

### 2. DOM order (`index.html`)

Move the `#strava-data-source` Connect panel above the `#archive-drop` zone so
the visual order matches the new step order. The archive drop becomes the
secondary/fallback surface beneath it.

### 3. Visual weight swap (`shared.css`)

Today the drop zone is a prominent bracketed box and the Strava panel
(`.data-sources--inline`) is deliberately quiet. Reordering DOM alone leaves the
loud box dominating below the quiet panel, which undercuts sync-first.

Swap the visual weight: give the Connect panel the prominent corner-bracket
treatment the drop zone uses today (reuse the `.drop` visual language), and
demote the archive drop to a quieter affordance below it. The Connect panel
becomes the eye-catching primary call to action; the drop zone reads as the
understated fallback.

### 4. No-flash default state (`index.html` + `src/app.js`)

The Connect panel is currently `hidden` in markup and un-hidden by
`refreshStravaUi()` after JS runs. As the new lead element this would cause a
gap/flash on load.

Fix: make the disconnected state ("Connect" + "Sync the last 180 days … no
archive download required") the **static default in the HTML** (panel visible,
not `hidden`). `refreshStravaUi()` keeps its current job: refine to the
"Connected · Sync 180 days / Disconnect" state when a stored session exists,
otherwise leave the disconnected default in place. The already-connected case
may briefly show the disconnected default before JS refines it; this is an
acceptable, minor transition and matches how the panel already behaves.

### 5. Housekeeping (`shared.css`)

- Adjust the entrance-animation delays (`shared.css:1734–1737`) to the new
  element order so the staggered fade-in still cascades top-to-bottom.
- The `body[data-app-state="data"]` rule already hides `#strava-data-source`
  (`shared.css:579`), so the results screen is unaffected by the reorder.

## Scope / files

- `index.html` — steps copy, element order, static default for the Connect panel.
- `shared.css` — visual-weight swap (promote Connect panel, demote drop zone),
  animation-delay order.
- `src/app.js` — minor adjustment to `refreshStravaUi()` so it refines rather
  than reveals the now-default-visible panel.

Out of scope: prediction/model logic, sync/auth behavior, the archive parsing
pipeline, the manual-entry (FTP/CP) disclosure.

## Testing

- Onboarding screen (no session): Connect panel renders first and prominent on
  load with no flash/gap; archive drop renders below as the quieter fallback.
- Onboarding screen (stored session): panel refines to the Connected state with
  Sync/Disconnect actions.
- Results screen (`data-app-state="data"`): steps, Connect panel, and drop zone
  all hidden as before.
- Step copy reads sync-first; archive guide link still resolves.
- Existing test suite (`npx vitest`) stays green — no JS logic paths changed
  beyond the panel default.
