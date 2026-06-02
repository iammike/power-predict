# Sync-first Intro Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the landing page so connecting/syncing Strava is the recommended primary path and the archive download is the optional fallback — in copy, DOM order, and visual weight.

**Architecture:** Pure presentation change. Rewrite the three "How it works" steps, move the Strava Connect panel above the archive drop zone, swap their visual weight in CSS, and make the Connect panel render visible by default (it is currently `hidden` until JS runs). No prediction, sync, auth, or parsing logic changes.

**Tech Stack:** Static `index.html`, `shared.css`, vanilla JS in `src/app.js`. Tests run with `npx vitest` (pure-logic suites; no DOM tests in this repo).

**Branch:** `sync-first-intro` (already created; spec committed there).

**Test strategy note:** This repo has no DOM/jsdom tests — its suites test pure functions. This change is copy + CSS + markup order, so verification is done in a browser (visual) plus keeping `npx vitest` green as a regression guard. Do **not** add a one-off jsdom test against project convention.

---

## File Structure

- `index.html` — the three step `<li>`s, the order of `#strava-data-source` vs `#archive-drop`, and the Connect panel's default (non-hidden) markup.
- `shared.css` — visual-weight swap (promote `.data-sources--inline`, demote `#archive-drop`) and entrance-animation delay order.
- `src/app.js` — verified to need **no logic change**: `refreshStravaUi()` already rebuilds the panel's status + actions on load, so it refines the new static default rather than revealing it. (Task 4 confirms this.)

---

## Task 1: Rewrite the three steps to sync-first copy

**Files:**
- Modify: `index.html:34-50`

- [ ] **Step 1: Replace the `<ol class="steps">` block**

Replace this exact block:

```html
    <ol class="steps" aria-label="How it works">
      <li>
        <span class="step-num">01 / Request</span>
        <h2>Ask Strava for your archive</h2>
        <p>They prepare it offline and email a link within hours. <a href="docs/strava-archive-guide.html">Step-by-step</a></p>
      </li>
      <li>
        <span class="step-num">02 / Drop</span>
        <h2>Drag the zip onto the page</h2>
        <p>Parsed in your browser. Raw streams never leave your machine.</p>
      </li>
      <li>
        <span class="step-num">03 / Read</span>
        <h2>See your power-duration curve</h2>
        <p>Connect Strava later so new rides flow in automatically.</p>
      </li>
    </ol>
```

with:

```html
    <ol class="steps" aria-label="How it works">
      <li>
        <span class="step-num">01 / Connect</span>
        <h2>Connect your Strava</h2>
        <p>Authorize once and we sync your last 180 days. No download, no waiting.</p>
      </li>
      <li>
        <span class="step-num">02 / Read</span>
        <h2>See your power-duration curve</h2>
        <p>Recent rides weighted heaviest, so it reflects current fitness.</p>
      </li>
      <li>
        <span class="step-num">03 / Extend</span>
        <h2>Want your full history?</h2>
        <p>Download your Strava archive and drop the zip in. Parsed in your browser; raw streams never leave your machine. <a href="docs/strava-archive-guide.html">Step-by-step</a></p>
      </li>
    </ol>
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "Reframe intro steps to lead with Strava sync"
```

---

## Task 2: Reorder surfaces and make the Connect panel visible by default

**Files:**
- Modify: `index.html:52-66`

Today the `#archive-drop` zone (line 52) renders before the `#strava-data-source` aside (line 58), and the aside is `hidden` until JS un-hides it. We move the aside above the drop, remove `hidden`, and seed the disconnected default (status sentence + Connect button) so the lead CTA is present before JS runs.

- [ ] **Step 1: Replace the drop + aside block**

Replace this exact block:

```html
    <div id="archive-drop" class="drop" tabindex="0" role="button" aria-label="Drop your archive">
      <input type="file" id="archive-input" accept=".zip" hidden>
      <span class="drop__label">Drop your archive</span>
      <span class="drop__hint">strava_export_*.zip · or click to browse</span>
    </div>

    <aside id="strava-data-source" class="data-sources data-sources--inline" aria-label="Strava data source" hidden>
      <section class="data-sources__row">
        <span class="data-sources__label">Strava</span>
        <p class="data-sources__line">
          <span class="data-sources__status" id="strava-status-text">Sync the last 180 days from your Strava account — no archive download required.</span>
          <span class="data-sources__actions" id="strava-status-actions"></span>
        </p>
      </section>
    </aside>
```

with (aside first, no `hidden`, static Connect button seeded; drop second):

```html
    <aside id="strava-data-source" class="data-sources data-sources--inline" aria-label="Strava data source">
      <section class="data-sources__row">
        <span class="data-sources__label">Strava</span>
        <p class="data-sources__line">
          <span class="data-sources__status" id="strava-status-text">Sync the last 180 days from your Strava account — no archive download required.</span>
          <span class="data-sources__actions" id="strava-status-actions"><button type="button" class="link-button" id="strava-connect-btn">Connect</button></span>
        </p>
      </section>
    </aside>

    <div id="archive-drop" class="drop" tabindex="0" role="button" aria-label="Drop your archive">
      <input type="file" id="archive-input" accept=".zip" hidden>
      <span class="drop__label">Drop your archive</span>
      <span class="drop__hint">strava_export_*.zip · or click to browse</span>
    </div>
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "Lead with the Strava Connect panel above the archive drop"
```

---

## Task 3: Swap visual weight and fix animation order in CSS

**Files:**
- Modify: `shared.css:359-363` (the `.data-sources--inline` block — promote to a bracketed card)
- Modify: `shared.css:299-308` (the `.drop` block — demote to a quieter affordance)
- Modify: `shared.css:1734-1738` (entrance-animation delays — new order)

The promoted Connect panel reuses the drop zone's corner-bracket visual language so it reads as the primary call to action; the drop zone shrinks and loses its brackets so it reads as the understated fallback below it.

- [ ] **Step 1: Promote the Connect panel — replace the `.data-sources--inline` block**

Replace:

```css
.data-sources--inline {
  margin: 1rem 0 0;
  padding: 0.6rem 0;
  border-top: 0;
}
```

with:

```css
/* On the onboarding screen this is the PRIMARY call to action, so it
   takes the prominent bracketed-card treatment the drop zone used to
   own. The internal row layout (label · status · actions) is unchanged. */
.data-sources--inline {
  position: relative;
  margin: 1.5rem 0 0;
  padding: clamp(1.75rem, 4vw, 2.5rem) 2rem;
  background: var(--paper-soft);
  border: 1px solid var(--hair-strong);
  border-top: 1px solid var(--hair-strong);
}
.data-sources--inline::before, .data-sources--inline::after {
  content: "";
  position: absolute;
  width: 14px; height: 14px;
  border: 1px solid var(--ink);
}
.data-sources--inline::before {
  top: -1px; left: -1px;
  border-right: none; border-bottom: none;
}
.data-sources--inline::after {
  bottom: -1px; right: -1px;
  border-left: none; border-top: none;
}
```

- [ ] **Step 2: Demote the drop zone — replace the `.drop` block**

Replace:

```css
.drop {
  position: relative;
  margin: 1.5rem 0 0;
  padding: clamp(2.5rem, 6vw, 4rem) 2rem;
  background: var(--paper-soft);
  border: 1px solid var(--hair-strong);
  text-align: center;
  cursor: pointer;
  transition: background 200ms ease, border-color 200ms ease;
}
.drop::before, .drop::after {
  content: "";
  position: absolute;
  width: 14px; height: 14px;
  border: 1px solid var(--ink);
  transition: border-color 200ms ease, width 200ms ease, height 200ms ease;
}
```

with (compact, no corner brackets — the brackets now belong to the Connect card):

```css
.drop {
  position: relative;
  margin: 0.75rem 0 0;
  padding: 1.25rem 2rem;
  background: var(--paper-soft);
  border: 1px dashed var(--hair-strong);
  text-align: center;
  cursor: pointer;
  transition: background 200ms ease, border-color 200ms ease;
}
```

Note: the existing `.drop::before, .drop::after` corner-bracket rules are removed by this replacement. The hover/focus rules at `.drop:hover, .drop.is-active, .drop:focus-visible` (background + border-color) still apply and keep the drop feeling interactive. The bracket-growth hover rules (`.drop:hover::before` …) now target nothing, which is harmless, but remove them in the next step for cleanliness.

- [ ] **Step 3: Remove the now-dead bracket-hover rules**

Delete this block (currently `shared.css:329-334`):

```css
.drop:hover::before, .drop:hover::after,
.drop.is-active::before, .drop.is-active::after,
.drop:focus-visible::before, .drop:focus-visible::after {
  border-color: var(--oxblood);
  width: 22px; height: 22px;
}
```

- [ ] **Step 4: Reorder entrance-animation delays**

The cascade should now flow steps → Connect panel → drop → manual. Replace:

```css
.drop              { animation-delay: 880ms; }
#strava-data-source { animation-delay: 940ms; }
.manual-mode       { animation-delay: 1000ms; }
```

with:

```css
#strava-data-source { animation-delay: 880ms; }
.drop              { animation-delay: 940ms; }
.manual-mode       { animation-delay: 1000ms; }
```

- [ ] **Step 5: Commit**

```bash
git add shared.css
git commit -m "Swap visual weight: Connect panel primary, drop zone secondary"
```

---

## Task 4: Confirm app.js needs no change, then verify in the browser

**Files:**
- Read-only check: `src/app.js:179-208` (`refreshStravaUi`)

- [ ] **Step 1: Confirm `refreshStravaUi` refines the new default**

Read `src/app.js:179-208`. Confirm it (a) sets `stravaDataSourceEl.hidden = false` — now a no-op since the panel is already visible, harmless; (b) rebuilds `#strava-status-text` and `#strava-status-actions` for both the connected and disconnected branches, re-wiring the Connect button listener. This means the static Connect button from Task 2 is correctly replaced and bound on load. No edit required. If any of these are not true, stop and re-evaluate before changing logic.

- [ ] **Step 2: Run the test suite (regression guard)**

Run: `npx vitest run`
Expected: PASS — all existing suites green. No new tests added; this confirms the presentation change broke no imported logic.

- [ ] **Step 3: Serve and visually verify the onboarding screen**

Run: `python3 -m http.server 8000` (from repo root), then open `http://localhost:8000/` in a browser (or use the `verify`/chrome-devtools tooling).

Verify, disconnected (no Strava session):
- Steps read 01 / Connect → 02 / Read → 03 / Extend.
- The Strava Connect panel renders **first** and **prominent** (bracketed card) with the "Sync the last 180 days … no archive download required." line and a working **Connect** button — no flash or empty gap on load.
- The archive drop zone renders **below**, visibly quieter (compact, dashed border, no corner brackets), still clickable/hover-reactive.
- Entrance animation cascades top-to-bottom without the Connect panel popping in late.

- [ ] **Step 4: Verify the connected and results states**

- With a stored session (connect once via the button), the panel refines to "Connected · Sync 180 days / Disconnect".
- After data loads (`data-app-state="data"`), the steps, Connect panel, and drop zone all hide as before (existing `shared.css:579` rule covers `#strava-data-source`).

- [ ] **Step 5: Final commit if any tuning was needed**

If Step 3/4 required CSS value tweaks (padding, spacing), commit them:

```bash
git add shared.css index.html
git commit -m "Tune sync-first intro spacing"
```

---

## Self-Review

- **Spec coverage:** §1 steps copy → Task 1. §2 DOM order → Task 2. §3 visual swap → Task 3 (steps 1-3). §4 no-flash default → Task 2 (remove `hidden` + static default) and Task 4 step 1. §5 housekeeping (animation delays, data-state hide already covered) → Task 3 step 4 + Task 4 step 4. All sections mapped.
- **Placeholders:** none — every code step shows full before/after.
- **Consistency:** element ids (`#strava-data-source`, `#archive-drop`, `#strava-status-actions`, `#strava-connect-btn`), class (`.data-sources--inline`, `.drop`), and CSS var names (`--paper-soft`, `--hair-strong`, `--ink`) match the live source read during planning.
