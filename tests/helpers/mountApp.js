// Shared harness for DOM-wiring integration tests (#239). Loads the real
// index.html markup into jsdom and imports a fresh src/app.js module
// instance against it, so app.js's module-scope event wiring and its
// unconditional hydrateFromCache() call run exactly as they do in a real
// page load.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import 'fake-indexeddb/auto';
import { clearActivities, clearSettings } from '../../src/storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '../../index.html'), 'utf8');

// The <script src="dist/app.min.js"> tag is inert either way -- a script
// element inserted via innerHTML never executes, per spec -- but stripping
// it keeps the mounted DOM's intent unambiguous: markup only, app.js comes
// from a real ESM import below.
const BODY_INNER = /<body>([\s\S]*)<\/body>/.exec(INDEX_HTML)[1]
  .replace(/<script[^>]*><\/script>\s*/, '');

// Empties both IndexedDB stores. Needed because vi.resetModules() only
// clears app.js's *module* graph -- indexedDB is a process-global that
// fake-indexeddb/auto patches once per test file, so activities/settings
// would otherwise persist test-to-test within the same file.
//
// Deliberately clears the stores rather than deleting+recreating the whole
// database: src/storage.js's openDb() never closes the connections it
// opens, so every mountApp() call (each importing a fresh app.js instance)
// leaves one more open connection behind. indexedDB.deleteDatabase() blocks
// until every open connection to that database closes, so once a prior
// test's app.js instance has an open connection, a delete queued behind it
// never resolves and every later open() call queues behind that stuck
// delete forever. clear() is a plain readwrite transaction and has no such
// exclusivity requirement, so it's unaffected by however many stale
// connections are still open.
export async function resetIndexedDb() {
  await clearActivities();
  await clearSettings();
}

// Re-seeds document.body from index.html and imports a fresh app.js
// instance against it. Seed any IndexedDB state (via saveActivities/
// saveSession/saveSettings, imported directly from ../../src/storage.js
// or ../../src/strava-session.js) BEFORE calling this -- app.js's
// module-scope hydrateFromCache() reads it immediately on import, and
// there is no re-hydrate hook to call afterward.
//
// Readiness can't be read off document.body.dataset.appState -- it's set
// synchronously to 'onboarding' before hydrateFromCache's first await, so
// it's truthy almost immediately regardless of whether hydration actually
// finished. It also can't be read off #strava-connect-btn's mere presence
// -- index.html ships that button statically as a no-JS fallback, so it
// exists in the DOM before app.js has run at all. Instead: capture the
// static button's node identity before importing app.js, then wait for
// refreshStravaUi() (hydrateFromCache()'s unconditional last step) to
// replace #strava-status-actions's contents -- it does this regardless of
// session state, so a new node in that slot is a reliable "hydrated" signal.
export async function mountApp({ resetDb = true } = {}) {
  if (resetDb) await resetIndexedDb();
  document.body.innerHTML = BODY_INNER;
  const staticConnectBtn = document.getElementById('strava-connect-btn');
  vi.resetModules();
  await import('../../src/app.js');
  // 5000ms, not vi.waitFor's 1000ms default: hydration is a handful of
  // real IndexedDB round trips, and running the full suite in parallel
  // (many spec files each opening/hydrating their own app.js instance
  // concurrently) has been observed to occasionally push a single mount
  // past 2000ms under CI-like load even though it settles in well under
  // 100ms in isolation.
  await vi.waitFor(() => {
    const btn = document.getElementById('strava-connect-btn')
      || document.getElementById('strava-sync-btn');
    if (!btn || btn === staticConnectBtn) throw new Error('app not hydrated yet');
  }, { timeout: 5000 });
}
