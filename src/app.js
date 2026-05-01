import { DURATIONS_S } from './mmp.js';
import { rollingBest, rollingBestWithOwners, estimateFtp } from './aggregate.js';
import { normalizeForDrift } from './drift.js';
import { renderCurveChart } from './curve-chart.js';
import { formatDuration, formatPower } from './format.js';
import {
  loadActivities,
  saveActivities,
  hasActivity,
  clearActivities,
  activityCount,
  loadSettings,
  saveSettings,
} from './storage.js';
import { fitCp2, fitCp3, fitFatigueK, predictPower, mmpToPoints } from './cpfit.js';
import { parseDuration } from './duration.js';
import { synthesizeFit } from './manual.js';
import { computeLoadSeries, formMultiplier, tsbBand } from './load.js';
import {
  parseAuthHash, clearAuthHash, loadSession, saveSession, clearSession, authorizeUrl,
  syncRecent, fetchSyncedActivities,
} from './strava-session.js';

const dropZone = document.getElementById('archive-drop');
const fileInput = document.getElementById('archive-input');
const progressEl = document.getElementById('progress');
const resultsEl = document.getElementById('results');
const stravaDataSourceEl = document.getElementById('strava-data-source');

if (dropZone && fileInput) {
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('is-active');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-active'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-active');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleArchive(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleArchive(file);
  });
}

const manualForm = document.getElementById('manual-form');
if (manualForm) {
  manualForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const unit = document.getElementById('manual-unit').value === 'cp' ? 'cp' : 'ftp';
    const value = Number(document.getElementById('manual-threshold').value);
    const ftpW = unit === 'cp' ? value / 0.95 : value;
    const sprintRaw = document.getElementById('manual-1min').value.trim();
    const sprint1minW = sprintRaw ? Number(sprintRaw) : null;
    const fit = synthesizeFit({ ftpW, sprint1minW });
    if (!fit) {
      setProgress('Enter a positive FTP or CP value (typical range 100-450 W).');
      return;
    }
    renderManualMode(fit, { ftpW, sprint1minW, unit });
  });
}

// User-settable fit overrides, persisted to IDB.
let currentSettings = {};
let currentActivities = [];

// Hydrate from IndexedDB on page load — returning visitors see their
// curve instantly without re-uploading.
hydrateFromCache();

async function hydrateFromCache() {
  setAppState('onboarding');
  // Drain any OAuth callback params from the URL hash *before* the
  // initial render — saving the session into settings here means the
  // settings load below sees them and the Connect/Connected toggle
  // takes the right state on first paint.
  await consumeAuthHash();
  try {
    const [cached, settings] = await Promise.all([loadActivities(), loadSettings()]);
    currentSettings = settings || {};
    currentActivities = cached;
    if (cached.length > 0) {
      renderCurves(cached, { fromCache: true });
    }
  } catch (err) {
    console.warn('cache hydrate failed', err);
  }
  await refreshStravaUi();
}

async function consumeAuthHash() {
  const parsed = parseAuthHash(typeof location !== 'undefined' ? location.hash : '');
  if (!parsed) return;
  clearAuthHash();
  if (parsed.error) {
    showAuthToast(`Connection failed: ${parsed.error}`, { error: true });
    console.warn('strava auth error', parsed.error);
    return;
  }
  if (parsed.session && parsed.athleteId) {
    await saveSession({ session: parsed.session, athleteId: parsed.athleteId });
    showAuthToast(`Connected to Strava · athlete ${parsed.athleteId}`);
  }
}

// Floating status banner anchored to the top of the page. One DOM
// element, shared across:
//   - auth toasts (transient, dismiss after 2.2 s)
//   - sync progress (live-updating, persists until cleared)
//   - sync completion (persists until next render)
//   - errors (oxblood styling, persists until cleared)
//
// `kind` controls styling. `persistent: true` skips the auto-dismiss
// timer so progress + completion stay visible. innerHTML accepted so
// callers can wrap numerals in <em> for the oxblood numeric accent.
let statusEl = null;
let statusDismissTimer = null;
function showStatus(html, { kind = 'info', persistent = false, dwellMs = 2200 } = {}) {
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.className = 'status-banner';
    document.body.appendChild(statusEl);
  }
  clearTimeout(statusDismissTimer);
  statusEl.className = `status-banner status-banner--${kind}`;
  statusEl.innerHTML = html;
  // Force reflow so .is-visible always animates in cleanly even when
  // we're re-using the element across rapid updates.
  // eslint-disable-next-line no-unused-expressions
  statusEl.offsetHeight;
  statusEl.classList.add('is-visible');
  if (!persistent) {
    statusDismissTimer = setTimeout(() => clearStatus(), dwellMs);
  }
}
function clearStatus() {
  if (!statusEl) return;
  clearTimeout(statusDismissTimer);
  statusEl.classList.remove('is-visible');
  // Match the CSS transition duration before pulling the element so
  // the fade-out actually completes.
  setTimeout(() => {
    if (statusEl && !statusEl.classList.contains('is-visible')) {
      statusEl.remove();
      statusEl = null;
    }
  }, 320);
}

// Back-compat shim: showAuthToast still works, just routed through
// the unified banner.
function showAuthToast(message, { error = false } = {}) {
  showStatus(message, { kind: error ? 'error' : 'success' });
}

async function refreshStravaUi() {
  if (!stravaDataSourceEl) return;
  const session = await loadSession();
  const statusEl = document.getElementById('strava-status-text');
  const actionsEl = document.getElementById('strava-status-actions');
  if (!statusEl || !actionsEl) return;
  stravaDataSourceEl.hidden = false;
  if (session) {
    statusEl.textContent = 'Connected.';
    actionsEl.innerHTML = `
      <button type="button" class="link-button" id="strava-sync-btn">Sync 180 days</button>
      <button type="button" class="link-button" id="strava-disconnect">Disconnect</button>
    `;
    document.getElementById('strava-sync-btn').addEventListener('click', triggerStravaSync);
    document.getElementById('strava-disconnect').addEventListener('click', handleDisconnect);
  } else {
    statusEl.textContent = 'Sync the last 180 days from your Strava account — no archive download required.';
    actionsEl.innerHTML = `<button type="button" class="link-button" id="strava-connect-btn">Connect</button>`;
    document.getElementById('strava-connect-btn').addEventListener('click', (e) => {
      beginStravaConnect(e.currentTarget);
    });
  }
}

async function handleDisconnect() {
  if (!confirm('Disconnect this browser from Strava? You can reconnect anytime.')) return;
  await clearSession();
  currentSettings = (await loadSettings()) || {};
  showAuthToast('Disconnected from Strava');
  await refreshStravaUi();
}

// Click feedback for any Connect Strava button. If Strava's session
// cookie auto-approves the flow, the user never actually sees
// Strava's UI — the redirect bounces back almost instantly. So the
// label says 'Connecting' rather than 'Opening Strava' to be honest
// in both cases. Also surface the same message in the floating top
// banner so the status reads consistently with sync / disconnect.
function beginStravaConnect(btn) {
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.dataset.originalText = btn.textContent;
    btn.textContent = 'Connecting to Strava ';
  }
  showStatus('Connecting to Strava', { kind: 'progress', persistent: true });
  setTimeout(() => window.location.assign(authorizeUrl('/')), 60);
}

// Single source of truth for the sync action. Drives the
// /sync/recent loop, then pulls the resulting MMP records back out
// of D1 and merges them into the local IDB cache so the rest of the
// app renders the same way as archive uploads.
async function triggerStravaSync() {
  const session = await loadSession();
  if (!session) return;
  // All sync messaging flows through the floating top-of-page status
  // banner — visible regardless of scroll position and consistent
  // with auth toasts / errors.
  const setSync = (html) => showStatus(html, { kind: 'progress', persistent: true });
  showStatus('Pulling activity list from Strava…', { kind: 'progress', persistent: true });
  try {
    // Tell the worker which Strava ids the IDB cache already has so it
    // skips them in the worklist — no point re-fetching streams the
    // user already ingested via archive upload.
    const knownIds = currentActivities
      .map((a) => a.stravaId)
      .filter((id) => id != null && id !== '');
    await syncRecent({
      session: session.session,
      days: 180,
      knownIds,
      onProgress: ({ processed, totalWithPower, remaining }) => {
        const total = Number.isFinite(totalWithPower) ? totalWithPower : '?';
        setSync(`Syncing from Strava · <em>${processed}</em> / <em>${total}</em> activities · <em>${remaining}</em> remaining`);
      },
    });
    setSync('Loading synced data…');
    const remoteActivities = await fetchSyncedActivities(session.session);
    if (remoteActivities.length === 0) {
      showStatus('No power-equipped rides in the synced window.', { kind: 'success', dwellMs: 3500 });
      return;
    }
    const fresh = [];
    for (const a of remoteActivities) {
      if (!(await hasActivity(a.startTime))) fresh.push(a);
    }
    if (fresh.length) await saveActivities(fresh);
    const all = await loadActivities();
    renderCurves(all);
    const noun = fresh.length === 1 ? 'ride' : 'rides';
    const completion = fresh.length === 0
      ? `Sync complete · already had everything in the window`
      : `Sync complete · <em>${fresh.length}</em> new ${noun} added`;
    showStatus(completion, { kind: 'success', dwellMs: 3500 });
  } catch (err) {
    console.error('strava sync failed', err);
    showStatus(`Strava sync failed: ${err.message || err}`, { kind: 'error', dwellMs: 5000 });
  }
}

async function handleArchive(file) {
  setProgressPhase('Reading', { bytesRead: 0, totalBytes: file.size });

  // Request a screen wake lock so a long parse isn't interrupted by
  // the system sleeping. Doesn't fully prevent tab-freeze on 5+ min
  // backgrounding but covers the common case (drop archive, lock the
  // screen / switch tabs, come back to results). API only available
  // over HTTPS and in modern browsers.
  let wakeLock = null;
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (err) {
    console.warn('wake lock unavailable', err);
  }
  // Re-acquire on visibility change in case the lock was released.
  const onVisibility = async () => {
    if (document.visibilityState === 'visible' && wakeLock?.released && 'wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Browsers throttle background tabs aggressively (Chrome's
  // "intensive wake-up throttling" affects Web Workers after a few
  // minutes hidden). A silent audio source keeps the tab classified
  // as actively playing media so the parsing worker runs full-speed
  // even when the tab loses focus. The tradeoff is a small "audio
  // playing" indicator on the tab strip while parsing.
  const audio = startSilentAudio();

  // Dedupe by startTime (the IDB primary key) within this run. Two
  // FIT files that share a start instant would otherwise both count
  // as "with power" while only one survives in IDB.
  const newActivities = new Map();
  const seenStartTimes = new Set();
  let withPower = 0;
  let skipped = 0;
  let lastActivitiesSeen = 0;
  let parseFailed = 0;
  let parseFailedSamples = [];

  const worker = new Worker('dist/archive-worker.js');

  try {
    await new Promise((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
      worker.onmessage = async (e) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          lastActivitiesSeen = msg.activitiesSeen;
          const phase = msg.phase === 'parsing' ? 'Parsing' : 'Reading';
          setProgressPhase(phase, {
            bytesRead: msg.bytesRead,
            totalBytes: msg.totalBytes,
            activitiesSeen: msg.activitiesSeen,
            parsedCount: msg.parsedCount,
            withPower: msg.withPower,
            skipped,
          });
        } else if (msg.type === 'activity') {
          if (seenStartTimes.has(msg.startTime)) return;
          seenStartTimes.add(msg.startTime);
          try {
            if (await hasActivity(msg.startTime)) {
              skipped++;
            } else {
              newActivities.set(msg.startTime, {
                startTime: msg.startTime,
                durationS: msg.durationS,
                distanceM: msg.distanceM,
                avgPower: msg.avgPower,
                npW: msg.npW ?? msg.avgPower,
                mmp: msg.mmp,
                stravaId: msg.stravaId ?? null,
              });
            }
            withPower++;
          } catch (err) {
            console.warn('cache check failed', err);
          }
        } else if (msg.type === 'done') {
          parseFailed = msg.failed || 0;
          parseFailedSamples = msg.failedSamples || [];
          resolve();
        } else if (msg.type === 'error') {
          reject(new Error(msg.message));
        }
      };
      worker.postMessage({ type: 'parse', file });
    });
  } catch (err) {
    console.error('archive worker failed', err);
    setProgress(`Archive read failed: ${err.message || err}`);
    worker.terminate();
    document.removeEventListener('visibilitychange', onVisibility);
    if (wakeLock) try { await wakeLock.release(); } catch {}
    audio?.stop();
    resetTitle();
    return;
  }
  worker.terminate();
  document.removeEventListener('visibilitychange', onVisibility);
  if (wakeLock) try { await wakeLock.release(); } catch {}
  audio?.stop();
  resetTitle();

  const newList = Array.from(newActivities.values());
  if (newList.length > 0) {
    setProgress(`Saving ${newList.length} new activities to local cache…`);
    await saveActivities(newList);
  }

  const all = await loadActivities();
  if (all.length === 0) {
    setProgress(
      `No power-equipped activities found in the archive (${lastActivitiesSeen} activity files seen).`
    );
    return;
  }

  // The activity count is already in the results foot note, so we
  // skip the "Done. N activities cached…" toast and just render —
  // leaving it up between the lede and the table read as orphaned
  // copy. The exception is when files failed to parse: that's
  // information the user needs, so we keep the progress slot for a
  // brief notice listing how many files were skipped.
  if (progressEl) {
    if (parseFailed > 0) {
      const sampleStr = parseFailedSamples.length
        ? ` (${parseFailedSamples.slice(0, 3).join(', ')}${parseFailed > 3 ? ', …' : ''})`
        : '';
      const noun = parseFailed === 1 ? 'file' : 'files';
      progressEl.hidden = false;
      progressEl.innerHTML = `<p class="progress__note">Skipped ${parseFailed} ${noun} that couldn’t be parsed${sampleStr}. See console for details.</p>`;
    } else {
      progressEl.textContent = '';
      progressEl.hidden = true;
      progressEl.innerHTML = '';
    }
  }
  renderCurves(all);
}

// Throttle progress writes via timestamp (not rAF — rAF doesn't fire
// when the main thread is blocked, leaving the bar permanently stuck).
// Re-query the inner DOM each call rather than caching refs, since
// caching across setProgress() resets was racy.
let lastProgressUpdate = 0;
let lastPhase = null;
const PROGRESS_THROTTLE_MS = 50;

// Roughly equal wall time for read vs. parse on a typical archive,
// so we split the unified bar 50/50. Tweakable.
const READ_WEIGHT = 0.5;

// A muted oscillator running through an audible-but-silent gain
// (1e-4) is enough to register as "media playing" with the browser
// and bypass background-tab throttling. We avoid 0 gain because some
// Chromium builds short-circuit truly silent graphs and stop
// counting the tab as active. Returned object exposes stop() so the
// caller can tear it down when parsing finishes.
function startSilentAudio() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return {
      stop() {
        try { osc.stop(); } catch {}
        try { ctx.close(); } catch {}
      },
    };
  } catch (err) {
    console.warn('silent audio unavailable', err);
    return null;
  }
}

function setProgressPhase(phase, payload) {
  if (!progressEl) return;
  const now = performance.now ? performance.now() : Date.now();
  lastPhase = phase;
  const readFrac = payload.totalBytes ? Math.min(1, payload.bytesRead / payload.totalBytes) : 0;
  const parseFrac = payload.activitiesSeen ? Math.min(1, payload.parsedCount / payload.activitiesSeen) : 0;
  const isParsing = phase === 'Parsing';
  const isComplete = isParsing ? parseFrac >= 1 : false;
  const isFirst = !progressEl.querySelector('.progress__bar');
  if (!isComplete && !isFirst && now - lastProgressUpdate < PROGRESS_THROTTLE_MS) return;
  lastProgressUpdate = now;

  if (isFirst) {
    progressEl.innerHTML =
      '<span class="progress__text"></span>' +
      '<span class="progress__bar"><span class="progress__bar-fill"></span></span>';
  }
  progressEl.hidden = false;

  // Combined 0-100 progress: read fills 0..50%, parse fills 50..100%.
  const overall = isParsing
    ? READ_WEIGHT * 100 + (1 - READ_WEIGHT) * parseFrac * 100
    : READ_WEIGHT * readFrac * 100;

  const phaseDetail = isParsing
    ? `Parsing: ${payload.parsedCount} / ${payload.activitiesSeen} activities (${(parseFrac * 100).toFixed(0)}%)${payload.withPower ? ` · ${payload.withPower} with power` : ''}${payload.skipped ? `, ${payload.skipped} cached` : ''}`
    : `Reading: ${formatBytes(payload.bytesRead)} / ${formatBytes(payload.totalBytes)} (${(readFrac * 100).toFixed(0)}%)${payload.activitiesSeen ? ` · ${payload.activitiesSeen} entries seen` : ''}`;

  // ETA removed — read and parse take very different amounts of time
  // per archive, so any single weighting produced misleading numbers.
  // The phase counters + bar position are honest enough on their own.

  const textEl = progressEl.querySelector('.progress__text');
  const fillEl = progressEl.querySelector('.progress__bar-fill');
  if (textEl) textEl.textContent = phaseDetail;
  if (fillEl) fillEl.style.width = `${overall}%`;

  // Mirror progress into document.title so the tab strip shows
  // movement even when the tab is hidden — browsers don't paint
  // hidden tabs, so the progress bar visually freezes for a tabbed-
  // away user even though the worker keeps running.
  document.title = isComplete
    ? 'Power Predict'
    : `${overall.toFixed(0)}% · ${phase} — Power Predict`;
}

const ORIGINAL_TITLE = typeof document !== 'undefined' ? document.title : 'Power Predict';
function resetTitle() {
  if (typeof document !== 'undefined') document.title = ORIGINAL_TITLE;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// Held in module scope so the predict form + chart toggles can read.
let currentFit = null;
let currentEftpNow = null;
let currentLoad = { ctl: 0, atl: 0, tsb: 0, hasFtp: false };
let currentMmpByWindow = { last30: {}, last90: {}, allTime: {}, range: {} };

function renderCurves(activityMmps, { fromCache = false } = {}) {
  currentActivities = activityMmps;
  setAppState(activityMmps.length > 0 ? 'data' : 'onboarding');
  // Filter activities by the user's date range, if set.
  const dateFromMs = currentSettings.dateFrom ? Date.parse(currentSettings.dateFrom) : null;
  const dateToMs = currentSettings.dateTo
    ? Date.parse(currentSettings.dateTo) + 86400_000 - 1
    : null;
  const filtered = (dateFromMs || dateToMs)
    ? activityMmps.filter((a) =>
        (!dateFromMs || a.startTime >= dateFromMs) &&
        (!dateToMs   || a.startTime <= dateToMs))
    : activityMmps;

  // The MMP table reports the rider's actual rolling-best across
  // their full archive — Last 30d, Last 90d, All-time are static
  // facts about their history. Date-range overrides only steer the
  // fit pipeline below; they don't recompute what the user has
  // demonstrably ridden.
  const allTime = rollingBest(activityMmps);
  const last90 = rollingBest(activityMmps, { windowDays: 90 });
  const last30 = rollingBest(activityMmps, { windowDays: 30 });
  const allTimeOwners = rollingBestWithOwners(activityMmps);
  const last90Owners = rollingBestWithOwners(activityMmps, { windowDays: 90 });
  const last30Owners = rollingBestWithOwners(activityMmps, { windowDays: 30 });
  // The chart shows the active date-range slice when an override
  // is set; otherwise it switches between the last30/last90/all-time
  // tabs. Filled in below once we know the fit's input set.
  currentMmpByWindow = { last30, last90, allTime, range: {} };

  // Effort-quality filter: drop activities whose IF (avg / FTP)
  // falls below the threshold so low-effort base rides don't anchor
  // the regression. Default ON. FTP is estimated from all-time best
  // 20-min MMP via Coggan's 0.95 factor.
  const ftp = estimateFtp(filtered);
  const minIF = currentSettings.minIF ?? 0.70;
  const effortOpts = ftp ? { minIF, ftp } : {};

  // The fit's regression uses raw rolling-best from the same window
  // the table displays — within 90 days, peak power IS what the
  // rider has demonstrated they can do. Recency weighting on top of
  // the window is over-engineering; physiology doesn't decay over
  // weeks the way the model implied. The effort filter handles the
  // "tons of zone-2 base" case by excluding low-IF rides outright.
  const fitWindow = (dateFromMs || dateToMs) ? null : 90;
  const last90Fit = rollingBest(filtered, { windowDays: fitWindow, ...effortOpts });
  // When a date range is active, the chart should show the rolling-
  // best from the selected slice — not the raw last-90-days view.
  // We use the fit's actual input set (sans effort filter so all
  // observed efforts in range still appear as dots).
  if (dateFromMs || dateToMs) {
    currentMmpByWindow.range = rollingBest(filtered);
  }

  // Drift-normalize for the all-time fallback so an old peak ridden
  // when the rider was demonstrably fitter doesn't anchor today's
  // prediction. Only the fallback path uses normalized data — the
  // displayed all-time table stays raw history.
  const drift = normalizeForDrift(filtered);
  const allTimeFitNorm = rollingBest(drift.activities, effortOpts);
  currentEftpNow = drift.eftpNow;

  // Prefer the 3-parameter (Morton) fit when it produces a sane
  // result — it handles short-duration data the 2-param hyperbola
  // can't. Fall back to 2-param if the data is too sparse or no
  // tau lands in the physical envelope.
  const primaryPoints = mmpToPoints(last90Fit);
  // Observed-point set for predictPower's Riegel anchor envelope.
  // Default is the unfiltered last-90-days view so a real ride from
  // a few weeks ago can still keep predictions honest. When the user
  // has actively narrowed to a date range, the anchor set should
  // match the range — otherwise an effort outside the chosen slice
  // leaks back into the prediction and disagrees with the chart.
  const primaryObservedRaw = (dateFromMs || dateToMs)
    ? rollingBest(filtered)
    : last90;
  const primaryObserved = mmpToPoints(primaryObservedRaw);
  const primaryFit =
    fitCp3(primaryPoints, undefined, { observedPoints: primaryObserved })
    || fitCp2(primaryPoints, undefined, { observedPoints: primaryObserved });
  const fallbackPoints = mmpToPoints(allTimeFitNorm);
  const fallbackObserved = mmpToPoints(allTime);
  const fallbackFit =
    fitCp3(fallbackPoints, undefined, { observedPoints: fallbackObserved })
    || fitCp2(fallbackPoints, undefined, { observedPoints: fallbackObserved });
  currentFit = primaryFit
    ? { ...primaryFit, fallback: false }
    : (fallbackFit ? { ...fallbackFit, fallback: true } : null);

  // Apply CP override on top of the fit (W' stays from the underlying
  // fit so the curve shape is data-derived, not a hand-set hyperbola).
  if (currentFit && Number.isFinite(currentSettings.cpOverrideW)) {
    currentFit = { ...currentFit, cpW: currentSettings.cpOverrideW, overridden: true };
  }

  // Personal fatigue exponent fitted from long-duration MMP. Replaces
  // the default Riegel k = 0.10 at predict time when enough 20-min-to-
  // 4-hr points exist. Falls back to the default otherwise.
  if (currentFit) {
    const fatigueSource = currentFit.fallback ? fallbackObserved : primaryObserved;
    currentFit = { ...currentFit, fatigue: fitFatigueK(fatigueSource) };
  }

  // Training-load (CTL/ATL/TSB) computed against the full archive,
  // not the date-filtered slice — TSB is about *current* fitness vs.
  // fatigue, anchored at "now," regardless of any fit override.
  // FTP for the IF calculation: 0.95 × CP from the fit (or null).
  const ftpForLoad = currentFit?.cpW ? currentFit.cpW / 0.95 : null;
  currentLoad = computeLoadSeries(activityMmps, ftpForLoad);

  const rows = DURATIONS_S
    .filter((d) => allTime[d] !== undefined)
    .map((d) => `
      <tr>
        <td>${formatDuration(d)}</td>
        <td>${renderMmpCell(last30Owners[d])}</td>
        <td class="featured">${renderMmpCell(last90Owners[d])}</td>
        <td>${renderMmpCell(allTimeOwners[d])}</td>
      </tr>`)
    .join('');

  // Preserve the predict input across re-renders so changing an
  // override (CP value, date range, preset) live-updates the existing
  // prediction instead of clearing it.
  const priorPredict = (() => {
    const input = document.getElementById('predict-input');
    const out = document.getElementById('predict-output');
    if (!input || !input.value) return null;
    return { value: input.value, hadOutput: out && !out.hidden };
  })();

  resultsEl.innerHTML = `
    <header class="results-head">
      <h2>Mean Maximal Power</h2>
      <span class="results-head__meta">Best avg watts held · raw, not normalized</span>
    </header>
    <table class="mmp-table">
      <thead>
        <tr>
          <th>Duration</th>
          <th>Last 30d</th>
          <th class="featured">Last 90d</th>
          <th title="Best across the entire local cache. Earlier rides may not be present if you only synced a recent window.">${allTimeLabel(activityMmps)}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <aside class="data-sources" aria-label="Data sources">
      <section class="data-sources__row">
        <span class="data-sources__label">Archive</span>
        <p class="data-sources__line">
          <span class="data-sources__status">${activityMmps.length.toLocaleString()} activities cached.</span>
          <span class="data-sources__actions">
            <button type="button" class="link-button" id="upload-another">Upload archive</button>
            <button type="button" class="link-button" id="clear-cache">Clear cache</button>
          </span>
        </p>
      </section>
      <section class="data-sources__row">
        <span class="data-sources__label">Strava</span>
        <p class="data-sources__line">
          ${currentSettings.stravaSession
            ? `<span class="data-sources__status">Connected.</span>
               <span class="data-sources__actions">
                 <button type="button" class="link-button" id="results-foot-sync">Sync 180 days</button>
                 <button type="button" class="link-button" id="results-foot-disconnect">Disconnect</button>
               </span>`
            : `<span class="data-sources__status">Sync the last 180 days from your Strava account — no archive download required.</span>
               <span class="data-sources__actions">
                 <button type="button" class="link-button" id="results-foot-connect">Connect</button>
               </span>`}
        </p>
      </section>
    </aside>
    ${renderPredictBlock()}
  `;
  resultsEl.hidden = false;
  resultsEl.dataset.revealed = '';
  document.getElementById('clear-cache').addEventListener('click', handleClearCache);
  document.getElementById('upload-another').addEventListener('click', () => {
    fileInput?.click();
  });
  document.getElementById('results-foot-sync')?.addEventListener('click', triggerStravaSync);
  document.getElementById('results-foot-connect')?.addEventListener('click', (e) => {
    beginStravaConnect(e.currentTarget);
  });
  document.getElementById('results-foot-disconnect')?.addEventListener('click', async () => {
    if (!confirm('Disconnect this browser from Strava? You can reconnect anytime.')) return;
    await clearSession();
    currentSettings = (await loadSettings()) || {};
    showAuthToast('Disconnected from Strava');
    renderCurves(currentActivities, { fromCache: true });
  });
  wirePredictForm();
  wireCurveChart();
  wireOverrideForm();

  if (priorPredict) {
    const input = document.getElementById('predict-input');
    if (input) {
      input.value = priorPredict.value;
      if (priorPredict.hadOutput) {
        document.getElementById('predict-form')?.dispatchEvent(
          new Event('submit', { cancelable: true })
        );
      }
    }
  }
}

// Quality bands for the fit stats. Bands are rules of thumb for the
// 2-param CP fit on real cyclist data; see methodology doc.
function rmseQuality(rmse) {
  if (rmse < 5)  return { label: 'excellent', cls: 'is-good' };
  if (rmse < 15) return { label: 'good',      cls: 'is-good' };
  if (rmse < 30) return { label: 'noisy',     cls: 'is-mid'  };
  return                 { label: 'poor fit', cls: 'is-bad'  };
}
function rmseTooltip(rmse) {
  return 'Root-mean-squared error of the regression. Lower = tighter fit. '
       + 'Typical bands: <5W excellent (clean test data), 5-15W good (real-world riding), '
       + '15-30W noisy, >30W means the model isn\'t fitting your data well. '
       + 'Note: the fit line is a least-squares smoother, so individual MMP dots can sit '
       + 'slightly above or below it — RMSE is the size of that gap.';
}
function pointsQuality(n) {
  // 9 durations available in our DURATIONS_S between 3 and 20 min.
  if (n >= 7) return { label: 'full',     cls: 'is-good' };
  if (n >= 4) return { label: 'ok',       cls: 'is-mid'  };
  if (n >= 2) return { label: 'minimal',  cls: 'is-bad'  };
  return            { label: 'too few',  cls: 'is-bad'  };
}
function cpQuality(fit) {
  if (fit.overridden) return { label: 'override', cls: 'is-mid'  };
  if (fit.fallback)   return { label: 'all-time', cls: 'is-mid'  };
  return                     { label: 'data',     cls: 'is-good' };
}
function cpTooltip(fit) {
  if (fit.overridden) return 'CP is pinned to your manual override. W\' is still derived from the regression so the curve shape stays data-driven.';
  if (fit.fallback)   return 'The 90-day window had too few MMP points in the fit range, so the fit fell back to all-time data.';
  if (fit.model === '3p' && Number.isFinite(fit.pMaxW)) {
    return `Critical Power asymptote — the wattage you could theoretically hold indefinitely if no other system failed. 3-parameter Morton fit: P_max ≈ ${Math.round(fit.pMaxW)} W (the short-duration asymptote that tames the curve below 3 minutes).`;
  }
  return 'CP came from a normal regression on the active window (last 90 days or your custom range).';
}
function wPrimeQuality(wPrimeJ) {
  const kJ = wPrimeJ / 1000;
  if (kJ < 8)  return { label: 'low',       cls: 'is-mid'  };
  if (kJ < 25) return { label: 'typical',   cls: 'is-good' };
  if (kJ < 40) return { label: 'high',      cls: 'is-good' };
  return            { label: 'very high', cls: 'is-mid'  };
}
function wPrimeTooltip(wPrimeJ) {
  return 'Anaerobic work capacity above CP. Trained cyclists typically sit in the 10-25 kJ range; '
       + 'sprinters and track riders push higher. Very high values from a 2-param fit can also signal '
       + 'a steep short-duration MMP relative to the threshold end — sanity-check against your sprint efforts.';
}
// Render an MMP table cell. Activity IDs are resolved through the
// archive's activities.csv during parsing — never from the FIT
// filename, which is Strava's upload ID and points to a different
// public activity. Cells without a resolved ID (legacy cache or an
// archive without activities.csv) render as plain text.
function renderMmpCell(owner) {
  if (!owner || typeof owner.value !== 'number') return '—';
  const watts = formatPower(owner.value);
  const date = Number.isFinite(owner.startTime)
    ? new Date(owner.startTime).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null;
  if (!owner.stravaId) {
    return date ? `<span title="${date}">${watts}</span>` : watts;
  }
  const title = date ? `${date} · open on Strava` : 'Open this activity on Strava';
  return `<a class="mmp-link" href="https://www.strava.com/activities/${owner.stravaId}" target="_blank" rel="noopener" title="${title}">${watts}</a>`;
}

// eFTP is computed from a 90-day window ending at the most recent
// activity in the fit's input set. With no override that's "now," so
// the chip reads "last 90d." With an override we describe the actual
// range: a preset (dateTo = today) collapses to "last Nd"; an explicit
// span renders as "Mar 31 → Apr 30"; a one-sided bound renders as
// "since X" or "through X".
// Header label for the all-time MMP column / chart tab. Falls back
// to literal 'All-time' when the cache reaches well into the past
// (≥ 3 years), otherwise reads as 'Since Mar 2024' so a 180-day
// sync user isn't told their three-month window is 'all-time'.
function allTimeLabel(activities) {
  if (!Array.isArray(activities) || activities.length === 0) return 'All-time';
  let minMs = Infinity;
  for (const a of activities) {
    if (Number.isFinite(a.startTime) && a.startTime < minMs) minMs = a.startTime;
  }
  if (!Number.isFinite(minMs)) return 'All-time';
  const ageDays = (Date.now() - minMs) / 86_400_000;
  if (ageDays > 365 * 3) return 'All-time';
  const d = new Date(minMs);
  return `Since ${d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
}

function eftpWindowLabel() {
  const { dateFrom, dateTo } = currentSettings;
  if (!dateFrom && !dateTo) return 'last 90d';
  const todayIso = new Date().toISOString().slice(0, 10);
  const fmt = (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  if (dateFrom && dateTo) {
    if (dateTo >= todayIso) {
      const days = Math.round(
        (Date.parse(dateTo) - Date.parse(dateFrom)) / 86400_000
      );
      if (days > 0) return `last ${days}d`;
    }
    return `${fmt(dateFrom)} → ${fmt(dateTo)}`;
  }
  if (dateFrom) return `since ${fmt(dateFrom)}`;
  return `through ${fmt(dateTo)}`;
}
function eftpTooltip() {
  const range = currentSettings.dateFrom || currentSettings.dateTo
    ? 'within your selected date range'
    : 'from your most recent 90 days';
  return `Estimated FTP ${range}: 0.95 × best 20-min MMP. Used to drift-normalize older efforts when the fit falls back to all-time data.`;
}

// Form (TSB) display helpers. TSB is unitless; we report it with a
// sign so a glance tells the user whether they're fresh or fatigued.
function formatTsb(tsb) {
  const v = Math.round(tsb);
  return v > 0 ? `+${v}` : String(v);
}
function formQuality() {
  const band = tsbBand(currentLoad.tsb);
  if (band === 'fresh')      return { label: 'fresh', cls: 'is-good' };
  if (band === 'building')   return { label: 'building', cls: 'is-mid' };
  if (band === 'overloaded') return { label: 'overloaded', cls: 'is-bad' };
  return { label: 'stable', cls: 'is-good' };
}
function formTooltip() {
  const ctl = Math.round(currentLoad.ctl);
  const atl = Math.round(currentLoad.atl);
  const adj = Math.round((formMultiplier(currentLoad.tsb) - 1) * 100);
  const adjStr = adj === 0 ? 'no adjustment' : `${adj > 0 ? '+' : ''}${adj}% applied to predictions`;
  return `Form (TSB) = CTL ${ctl} − ATL ${atl}. Positive = fresh; negative = fatigued. ${adjStr}. Capped at ±5%.`;
}

// Fatigue k: personal Riegel exponent fitted from 20-min-to-4-hr MMP.
// When data is too sparse to fit, predictions fall back to k = 0.10 —
// we show that here too so the cell isn't ever blank.
function fatigueValue(fit) {
  const k = fit.fatigue?.k ?? 0.10;
  return k.toFixed(2);
}
function fatigueQuality(fit) {
  if (!fit.fatigue) return { label: 'default', cls: 'is-mid' };
  if (fit.fatigue.clamped) return { label: 'clamped', cls: 'is-mid' };
  return { label: `${fit.fatigue.nPoints} pts`, cls: 'is-good' };
}
function fatigueTooltip(fit) {
  if (!fit.fatigue) {
    return 'Riegel fatigue exponent k governs how predicted power decays past 20 min: '
         + 'P(t) = P_anchor × (t_anchor / t)^k. Need 3+ MMP points between 20 min and 4 h '
         + 'to fit a personal value; falling back to the cycling default 0.10.';
  }
  const note = fit.fatigue.clamped
    ? ` Raw fit was ${fit.fatigue.kRaw.toFixed(2)}, clamped into the 0.04–0.20 plausible range.`
    : '';
  return `Personal Riegel fatigue exponent fitted from ${fit.fatigue.nPoints} long-duration MMP points `
       + `(20 min – 4 h). Lower k = better endurance fall-off. Cycling default is 0.10.${note}`;
}

// Combined fit-quality summary: pick whichever of RMSE / points is
// the worse of the two so the headline label reflects the limiting
// factor. Tooltip lists both numbers + the per-axis interpretation.
const QUALITY_RANK = { 'is-good': 0, 'is-mid': 1, 'is-bad': 2 };
function combinedFitQuality(fit) {
  const r = rmseQuality(fit.rmse);
  const p = pointsQuality(fit.nPoints);
  return QUALITY_RANK[p.cls] >= QUALITY_RANK[r.cls] ? p : r;
}
function combinedFitTooltip(fit) {
  return `Fit quality summary. RMSE ${fit.rmse.toFixed(1)} W (${rmseQuality(fit.rmse).label}) · ${fit.nPoints} points (${pointsQuality(fit.nPoints).label}). `
       + 'RMSE is regression error in watts; points is how many MMP durations between 3 and 20 min the fit had to work with.';
}

function pointsTooltip(n) {
  return 'Number of MMP points (durations between 3 and 20 minutes) the regression fitted on. '
       + 'Up to 9 possible. 7+ is a full picture, 4-6 is workable, 2-3 is minimal — '
       + 'a fit through only 2 points has no error to speak of but very little to corroborate it.';
}

function renderOverrideForm() {
  // The applied override is always stored as cpOverrideW. The
  // input mode (`overrideUnit`: 'ftp' | 'cp') controls how we
  // round-trip the number through the form: FTP mode displays
  // cpOverrideW / 0.95 and saves user_value × 0.95 back.
  const unit = currentSettings.overrideUnit === 'cp' ? 'cp' : 'ftp';
  const cpW = currentSettings.cpOverrideW;
  const displayValue = Number.isFinite(cpW)
    ? (unit === 'ftp' ? Math.round(cpW / 0.95) : Math.round(cpW))
    : '';
  const from = currentSettings.dateFrom || '';
  const to = currentSettings.dateTo || '';
  return `
    <details class="override-panel" ${
      currentSettings.cpOverrideW || currentSettings.dateFrom || currentSettings.dateTo
        ? 'open' : ''
    }>
      <summary>Manual override</summary>
      <form class="override-form" id="override-form" data-unit="${unit}">
        <section class="override-form__col override-form__col--threshold">
          <header class="override-form__col-head">
            <h4>Threshold</h4>
            <div class="override-form__unit-toggle" role="tablist" aria-label="Threshold unit">
              <button type="button" role="tab" data-unit="ftp" class="${unit === 'ftp' ? 'is-active' : ''}" aria-selected="${unit === 'ftp'}">FTP</button>
              <button type="button" role="tab" data-unit="cp"  class="${unit === 'cp'  ? 'is-active' : ''}" aria-selected="${unit === 'cp'}">CP</button>
            </div>
          </header>
          <div class="override-form__threshold-input">
            <input type="number" id="cp-override" min="50" max="600" step="1" value="${displayValue}" placeholder="280" inputmode="numeric">
            <span class="override-form__threshold-unit">W</span>
          </div>
          <p class="override-form__resolved" id="threshold-resolved" aria-live="polite"></p>
        </section>

        <div class="override-form__rule" aria-hidden="true"><span>or</span></div>

        <section class="override-form__col override-form__col--range">
          <header class="override-form__col-head">
            <h4>Date range</h4>
          </header>
          <div class="override-form__date-row">
            <label>
              <span>From</span>
              <input type="date" id="date-from" value="${from}">
            </label>
            <label>
              <span>To</span>
              <input type="date" id="date-to" value="${to}">
            </label>
          </div>
          <div class="override-form__presets" role="group" aria-label="Date range presets">
            <span class="override-form__presets-label">Quick set</span>
            <button type="button" data-preset-days="15">15d</button>
            <button type="button" data-preset-days="30">30d</button>
            <button type="button" data-preset-days="45">45d</button>
            <button type="button" data-preset-days="60">60d</button>
            <button type="button" data-preset-days="90">90d</button>
            <button type="button" data-preset-days="180">6mo</button>
            <button type="button" data-preset-days="365">1y</button>
          </div>
        </section>

        <footer class="override-form__actions">
          <button type="submit">Apply</button>
          <button type="button" class="link-button" id="reset-override">Reset</button>
        </footer>
      </form>
    </details>
  `;
}

function wireOverrideForm() {
  const form = document.getElementById('override-form');
  if (!form) return;
  const valueInput = document.getElementById('cp-override');
  const resolvedEl = document.getElementById('threshold-resolved');
  const toggleButtons = form.querySelectorAll('.override-form__unit-toggle button');

  const refreshResolved = () => {
    const unit = form.dataset.unit === 'cp' ? 'cp' : 'ftp';
    const value = Number(valueInput.value);
    if (!Number.isFinite(value) || value <= 0) {
      resolvedEl.textContent = '';
      return;
    }
    const cpW = unit === 'ftp' ? Math.round(value * 0.95) : Math.round(value);
    resolvedEl.innerHTML = unit === 'ftp'
      ? `Setting CP to <em>${cpW} W</em>`
      : `CP set <em>directly</em>`;
  };

  toggleButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.unit === 'cp' ? 'cp' : 'ftp';
      form.dataset.unit = next;
      toggleButtons.forEach((b) => {
        const active = b.dataset.unit === next;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });
      refreshResolved();
    });
  });
  valueInput.addEventListener('input', refreshResolved);
  refreshResolved();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const valueStr = valueInput.value.trim();
    const unit = form.dataset.unit === 'cp' ? 'cp' : 'ftp';
    const from = document.getElementById('date-from').value;
    const to = document.getElementById('date-to').value;
    const value = valueStr ? Number(valueStr) : null;
    const cpW = Number.isFinite(value)
      ? (unit === 'ftp' ? value * 0.95 : value)
      : null;
    currentSettings = {
      ...currentSettings,
      cpOverrideW: cpW,
      overrideUnit: unit,
      dateFrom: from || null,
      dateTo: to || null,
    };
    await saveSettings(currentSettings);
    renderCurves(currentActivities, { fromCache: true });
  });
  document.getElementById('reset-override').addEventListener('click', async () => {
    // Reset clears the override-form fields (CP override + date range)
    // but must preserve the Strava session — those keys belong to a
    // different feature, not the user's fit overrides.
    const preserved = {
      stravaSession: currentSettings.stravaSession,
      stravaAthleteId: currentSettings.stravaAthleteId,
    };
    currentSettings = Object.fromEntries(
      Object.entries(preserved).filter(([, v]) => v != null)
    );
    await saveSettings(currentSettings);
    renderCurves(currentActivities, { fromCache: true });
  });
  document.querySelectorAll('.override-form__presets [data-preset-days]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const days = Number(btn.dataset.presetDays);
      const today = new Date();
      const from = new Date(today);
      from.setDate(today.getDate() - days);
      const fmt = (d) => d.toISOString().slice(0, 10);
      currentSettings = {
        ...currentSettings,
        dateFrom: fmt(from),
        dateTo: fmt(today),
      };
      await saveSettings(currentSettings);
      renderCurves(currentActivities, { fromCache: true });
    });
  });
}

function wireCurveChart() {
  const container = document.getElementById('curve-chart');
  if (!container || !currentFit) return;
  const tabs = document.querySelectorAll('[data-window]');
  const draw = (key) => {
    renderCurveChart(container, {
      mmp: currentMmpByWindow[key] || {},
      fit: currentFit,
    });
    tabs.forEach((t) => t.classList.toggle('is-active', t.dataset.window === key));
  };
  if (tabs.length === 0) {
    // Date range is active — no tabs, just draw the in-range
    // rolling-best so the dots match what the fit actually saw.
    draw('range');
    return;
  }
  tabs.forEach((t) => {
    t.addEventListener('click', () => draw(t.dataset.window));
  });
  draw('last90');
}

// Manual mode: synthesize a CP/W' from the rider's FTP and render
// just the predict block. No MMP table, no chart of history, no
// override panel — there's nothing of theirs to override.
function renderManualMode(fit, inputs = {}) {
  // Snapshot the existing data-driven state so the user can swap
  // back without reloading. Manual mode replaces the rendered view
  // but does not clear IDB or the in-memory activity list — we just
  // hold onto it for the "Back to my data" link below.
  const priorActivities = currentActivities;
  const priorSettings = currentSettings;
  currentFit = fit;
  currentEftpNow = null;
  currentLoad = { ctl: 0, atl: 0, tsb: 0, hasFtp: false };
  currentMmpByWindow = { last30: {}, last90: {}, allTime: {}, range: {} };
  const hasPriorData = priorActivities.length > 0;

  const unit = inputs.unit === 'cp' ? 'cp' : 'ftp';
  const thresholdInit = Number.isFinite(inputs.ftpW)
    ? Math.round(unit === 'cp' ? inputs.ftpW * 0.95 : inputs.ftpW)
    : '';
  const sprintInit = Number.isFinite(inputs.sprint1minW) ? Math.round(inputs.sprint1minW) : '';
  const headerMeta = unit === 'cp' ? 'Synthesized from CP' : 'Synthesized from FTP';

  resultsEl.innerHTML = `
    <section class="predict predict--manual">
      <header class="results-head">
        <h2>Predict <span class="override-badge">MANUAL MODE</span></h2>
        <span class="results-head__meta">${headerMeta}</span>
      </header>

      <form class="manual-inline" id="manual-inline" novalidate>
        <label class="manual-inline__field">
          <span>Threshold</span>
          <div class="manual-inline__combo">
            <select id="manual-inline-unit" aria-label="Threshold unit">
              <option value="ftp" ${unit === 'ftp' ? 'selected' : ''}>FTP</option>
              <option value="cp" ${unit === 'cp' ? 'selected' : ''}>CP</option>
            </select>
            <input type="number" id="manual-inline-threshold" min="50" max="600" step="1" value="${thresholdInit}" autocomplete="off">
            <span class="manual-inline__unit">W</span>
          </div>
        </label>
        <label class="manual-inline__field">
          <span>1-min sprint (W) <em>optional</em></span>
          <input type="number" id="manual-inline-1min" min="50" max="2000" step="1" value="${sprintInit}" autocomplete="off">
        </label>
      </form>

      <dl class="fit-stats" id="manual-fit-stats">
        <div data-tooltip="Critical Power synthesized from the FTP you entered. CP ≈ 0.95 × FTP.">
          <dt>CP</dt>
          <dd id="manual-cp">${formatPower(fit.cpW)}</dd>
          <span class="fit-stats__quality is-mid">manual</span>
        </div>
        <div data-tooltip="Anaerobic work capacity. Derived from your 1-minute sprint number when given, otherwise defaulted to 18 kJ.">
          <dt>W'</dt>
          <dd id="manual-wprime">${(fit.wPrimeJ / 1000).toFixed(1)} kJ</dd>
          <span class="fit-stats__quality is-mid">manual</span>
        </div>
      </dl>

      <p class="results-foot__note manual-note">
        Predictions will be coarse compared to a real archive — the model has no information about your
        sprint kinetics or your endurance fade. Upload your Strava archive when you can to anchor the
        long-duration end of the curve.
      </p>

      <form class="predict-form" id="predict-form">
        <label class="predict-form__field">
          <span>Target duration</span>
          <input type="text" id="predict-input" placeholder="45m or 2h30m" autocomplete="off" spellcheck="false" required>
        </label>
        <button type="submit">Predict</button>
      </form>
      <output class="predict-output" id="predict-output" hidden></output>

      ${hasPriorData ? `
        <div class="results-foot results-foot--manual">
          <div class="results-foot__actions">
            <button type="button" class="link-button" id="manual-back">← Back to my data (${priorActivities.length})</button>
          </div>
        </div>
      ` : ''}
    </section>
  `;
  resultsEl.hidden = false;
  resultsEl.dataset.revealed = '';
  wirePredictForm();
  wireManualInline();
  setAppState('manual');
  // Manual mode no longer rebuilds Archive / Strava controls in the
  // result block — the onboarding entries at the top of the page stay
  // visible across manual state, so users have natural access to drop
  // an archive or hit Connect / Sync without leaving the page.
  if (hasPriorData) {
    document.getElementById('manual-back').addEventListener('click', () => {
      currentSettings = priorSettings;
      renderCurves(priorActivities, { fromCache: true });
    });
  }
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// App states drive top-level layout visibility via CSS:
//   onboarding — fresh visitor, drop zone + steps + manual disclosure shown
//   data       — archive loaded, only results visible
//   manual     — FTP-only synthesis, only manual predict block visible
function setAppState(state) {
  document.body.dataset.appState = state;
}

function wireManualInline() {
  const unitSelect = document.getElementById('manual-inline-unit');
  const valueInput = document.getElementById('manual-inline-threshold');
  const sprintInput = document.getElementById('manual-inline-1min');
  if (!unitSelect || !valueInput || !sprintInput) return;
  const recompute = () => {
    const unit = unitSelect.value === 'cp' ? 'cp' : 'ftp';
    const value = Number(valueInput.value);
    const ftpW = unit === 'cp' ? value / 0.95 : value;
    const sprintRaw = sprintInput.value.trim();
    const sprint1minW = sprintRaw ? Number(sprintRaw) : null;
    const fit = synthesizeFit({ ftpW, sprint1minW });
    if (!fit) return;
    currentFit = fit;
    const cpEl = document.getElementById('manual-cp');
    const wpEl = document.getElementById('manual-wprime');
    if (cpEl) cpEl.textContent = formatPower(fit.cpW);
    if (wpEl) wpEl.textContent = `${(fit.wPrimeJ / 1000).toFixed(1)} kJ`;
    const metaEl = document.querySelector('.predict--manual .results-head__meta');
    if (metaEl) metaEl.textContent = unit === 'cp' ? 'Synthesized from CP' : 'Synthesized from FTP';
    // If a prediction is already showing, refresh it against the new fit.
    const out = document.getElementById('predict-output');
    if (out && !out.hidden) {
      document.getElementById('predict-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  };
  unitSelect.addEventListener('change', recompute);
  valueInput.addEventListener('input', recompute);
  sprintInput.addEventListener('input', recompute);
}

function renderPredictBlock() {
  if (!currentFit) {
    return `
      <section class="predict">
        <header class="results-head">
          <h2>Predict</h2>
          <span class="results-head__meta">Need 2+ MMP points in 3-20 min</span>
        </header>
        <p class="results-foot__note">Not enough data yet to fit a critical-power model. Drop more activities to populate the 3-20 minute MMP window.</p>
      </section>
    `;
  }

  const overrideActive = !!(
    currentSettings.cpOverrideW ||
    currentSettings.dateFrom ||
    currentSettings.dateTo
  );
  const modelLabel = currentFit.model === '3p' ? '3-param CP' : '2-param CP';
  const headerMeta = overrideActive
    ? `${modelLabel} · custom override`
    : `${modelLabel} · last 90 days, effort-filtered`;

  return `
    <section class="predict">
      <header class="results-head">
        <h2>Predict ${overrideActive ? '<span class="override-badge">OVERRIDE</span>' : ''}</h2>
        <span class="results-head__meta">${headerMeta}</span>
      </header>

      <dl class="fit-stats">
        <div data-tooltip="${cpTooltip(currentFit)}">
          <dt>CP${currentFit.overridden ? ' *' : ''}</dt>
          <dd>${formatPower(currentFit.cpW)}</dd>
          <span class="fit-stats__quality ${cpQuality(currentFit).cls}">${cpQuality(currentFit).label}</span>
        </div>
        <div data-tooltip="${wPrimeTooltip(currentFit.wPrimeJ)}">
          <dt>W'</dt>
          <dd>${(currentFit.wPrimeJ / 1000).toFixed(1)} kJ</dd>
          <span class="fit-stats__quality ${wPrimeQuality(currentFit.wPrimeJ).cls}">${wPrimeQuality(currentFit.wPrimeJ).label}</span>
        </div>
        ${currentEftpNow ? `
        <div data-tooltip="${eftpTooltip()}">
          <dt>eFTP</dt>
          <dd>${formatPower(currentEftpNow)}</dd>
          <span class="fit-stats__quality is-good">${eftpWindowLabel()}</span>
        </div>` : ''}
        ${currentLoad.hasFtp ? `
        <div data-tooltip="${formTooltip()}">
          <dt>Form</dt>
          <dd>${formatTsb(currentLoad.tsb)}</dd>
          <span class="fit-stats__quality ${formQuality().cls}">${formQuality().label}</span>
        </div>` : ''}
        <div data-tooltip="${fatigueTooltip(currentFit)}">
          <dt>Fatigue k</dt>
          <dd>${fatigueValue(currentFit)}</dd>
          <span class="fit-stats__quality ${fatigueQuality(currentFit).cls}">${fatigueQuality(currentFit).label}</span>
        </div>
        <div data-tooltip="${combinedFitTooltip(currentFit)}">
          <dt>Fit</dt>
          <dd>${currentFit.rmse.toFixed(1)}W · ${currentFit.nPoints}pt</dd>
          <span class="fit-stats__quality ${combinedFitQuality(currentFit).cls}">${combinedFitQuality(currentFit).label}</span>
        </div>
      </dl>

      ${renderOverrideForm()}

      <div class="curve-chart-section">
        <header class="curve-chart-head">
          <span class="curve-chart-title">Power-duration curve</span>
          ${(currentSettings.dateFrom || currentSettings.dateTo)
            ? `<span class="curve-range-label">Range: ${currentSettings.dateFrom || '…'} → ${currentSettings.dateTo || '…'}</span>`
            : `<div class="curve-window-tabs" role="tablist">
                <button type="button" data-window="last30" role="tab">Last 30d</button>
                <button type="button" data-window="last90" role="tab" class="is-active">Last 90d</button>
                <button type="button" data-window="allTime" role="tab">${allTimeLabel(currentActivities)}</button>
              </div>`
          }
        </header>
        <div id="curve-chart" class="curve-chart"></div>
      </div>

      <form class="predict-form" id="predict-form">
        <label class="predict-form__field">
          <span>Target duration</span>
          <input type="text" id="predict-input" placeholder="45m or 2h30m" autocomplete="off" spellcheck="false" required>
        </label>
        <button type="submit">Predict</button>
      </form>
      <output class="predict-output" id="predict-output" hidden></output>
    </section>
  `;
}

function wirePredictForm() {
  const form = document.getElementById('predict-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('predict-input');
    const out = document.getElementById('predict-output');
    const seconds = parseDuration(input.value);
    if (!seconds) {
      out.hidden = false;
      out.innerHTML = `<p class="predict-output__error">Couldn't parse that. Try "45m", "1h30m", or "90s".</p>`;
      return;
    }
    const decayOpt = currentFit.fatigue ? { decay: { k: currentFit.fatigue.k } } : {};
    const raw = predictPower(currentFit, seconds, decayOpt);
    if (!raw) {
      out.hidden = false;
      out.innerHTML = `<p class="predict-output__error">Prediction failed.</p>`;
      return;
    }
    // Apply the form-based multiplier to the predicted wattage and
    // its confidence band. Capped at ±5% inside formMultiplier so
    // it's a nudge, not a rewrite. We surface the applied delta on the
    // output so the user can reconcile the predicted watts against the
    // chart curve (which doesn't bake form in).
    const mult = currentLoad.hasFtp ? formMultiplier(currentLoad.tsb) : 1;
    const result = mult === 1 ? raw : {
      ...raw,
      powerW: raw.powerW * mult,
      low: raw.low * mult,
      high: raw.high * mult,
    };
    const adjPct = Math.round((mult - 1) * 100);
    const formChip = adjPct === 0
      ? ''
      : `<span class="predict-output__flag predict-output__flag--form" title="${formTooltip()}">${adjPct > 0 ? '+' : ''}${adjPct}% form</span>`;
    out.hidden = false;
    out.innerHTML = `
      <p class="predict-output__label">Predicted for ${formatDuration(seconds)}</p>
      <p class="predict-output__value">${Math.round(result.powerW)}<span class="predict-output__unit">W</span></p>
      <p class="predict-output__band">
        Range ${Math.round(result.low)}–${Math.round(result.high)} W
        ${result.extrapolated ? '<span class="predict-output__flag">extrapolated</span>' : ''}
        ${formChip}
      </p>
    `;
  });
}

async function handleClearCache() {
  if (!confirm('Clear all cached activity data from this browser?')) return;
  await clearActivities();
  resultsEl.hidden = true;
  resultsEl.innerHTML = '';
  currentActivities = [];
  setAppState('onboarding');
  setProgress(`Cache cleared. ${await activityCount()} activities remaining.`);
}

function setProgress(msg) {
  if (!progressEl) return;
  progressEl.textContent = msg;
  progressEl.hidden = false;
}

// Build/version tag in the footer so we can confirm a deploy landed.
// version.json is written by the deploy workflow at build time.
(async () => {
  try {
    const el = document.getElementById('build-version');
    if (!el) return;
    let text = 'dev';
    let href = null;
    try {
      const res = await fetch('version.json', { cache: 'no-store' });
      if (res.ok) {
        const v = await res.json();
        if (v?.commit) {
          text = v.commit;
          href = v.url || null;
        }
      }
    } catch { /* keep "dev" */ }
    const live = document.getElementById('build-version');
    if (!live) return;
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = text;
      live.replaceChildren(a);
    } else {
      live.textContent = text;
    }
  } catch (err) {
    console.warn('build version tag failed', err);
  }
})();
