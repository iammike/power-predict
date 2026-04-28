import { DURATIONS_S } from './mmp.js';
import { rollingBest, estimateFtp } from './aggregate.js';
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
import { fitCp2, predictPower, mmpToPoints } from './cpfit.js';
import { parseDuration } from './duration.js';

const dropZone = document.getElementById('archive-drop');
const fileInput = document.getElementById('archive-input');
const progressEl = document.getElementById('progress');
const resultsEl = document.getElementById('results');

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

// User-settable fit overrides, persisted to IDB.
let currentSettings = {};
let currentActivities = [];

// Hydrate from IndexedDB on page load — returning visitors see their
// curve instantly without re-uploading.
hydrateFromCache();

async function hydrateFromCache() {
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

  // Dedupe by startTime (the IDB primary key) within this run. Two
  // FIT files that share a start instant would otherwise both count
  // as "with power" while only one survives in IDB.
  const newActivities = new Map();
  const seenStartTimes = new Set();
  let withPower = 0;
  let skipped = 0;
  let lastActivitiesSeen = 0;

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
                mmp: msg.mmp,
              });
            }
            withPower++;
          } catch (err) {
            console.warn('cache check failed', err);
          }
        } else if (msg.type === 'done') {
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
    return;
  }
  worker.terminate();
  document.removeEventListener('visibilitychange', onVisibility);
  if (wakeLock) try { await wakeLock.release(); } catch {}

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

  setProgress(
    `Done. ${all.length} activities cached locally (${newList.length} new this run, ${skipped} already cached, ${withPower} with power out of ${lastActivitiesSeen} activity files).`
  );
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
let currentMmpByWindow = { last30: {}, last90: {}, allTime: {} };

function renderCurves(activityMmps, { fromCache = false } = {}) {
  currentActivities = activityMmps;
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

  const allTime = rollingBest(filtered);
  const last90 = rollingBest(filtered, { windowDays: 90 });
  const last30 = rollingBest(filtered, { windowDays: 30 });
  currentMmpByWindow = { last30, last90, allTime };

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
  const allTimeFit = rollingBest(filtered, effortOpts);
  const primaryFit = fitCp2(mmpToPoints(last90Fit), undefined, { observedPoints: mmpToPoints(last90) });
  const fallbackFit = fitCp2(mmpToPoints(allTimeFit), undefined, { observedPoints: mmpToPoints(allTime) });
  currentFit = primaryFit
    ? { ...primaryFit, fallback: false }
    : (fallbackFit ? { ...fallbackFit, fallback: true } : null);

  // Apply CP override on top of the fit (W' stays from the underlying
  // fit so the curve shape is data-derived, not a hand-set hyperbola).
  if (currentFit && Number.isFinite(currentSettings.cpOverrideW)) {
    currentFit = { ...currentFit, cpW: currentSettings.cpOverrideW, overridden: true };
  }

  const rows = DURATIONS_S
    .filter((d) => allTime[d] !== undefined)
    .map((d) => `
      <tr>
        <td>${formatDuration(d)}</td>
        <td>${last30[d] !== undefined ? formatPower(last30[d]) : '—'}</td>
        <td class="featured">${last90[d] !== undefined ? formatPower(last90[d]) : '—'}</td>
        <td>${formatPower(allTime[d])}</td>
      </tr>`)
    .join('');

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
          <th>All-time</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="results-foot">
      <p class="results-foot__note">
        ${activityMmps.length} activities cached locally${fromCache ? ', loaded from your last visit.' : '.'}
      </p>
      <button type="button" class="link-button" id="clear-cache">Clear cached data</button>
    </div>
    ${renderPredictBlock()}
  `;
  resultsEl.hidden = false;
  resultsEl.dataset.revealed = '';
  document.getElementById('clear-cache').addEventListener('click', handleClearCache);
  wirePredictForm();
  wireCurveChart();
  wireOverrideForm();
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
       + '15-30W noisy, >30W means the model isn\'t fitting your data well.';
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
  if (fit.fallback)   return 'The 90-day window had too few MMP points in the 3-20 min range, so the fit fell back to all-time data.';
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
function pointsTooltip(n) {
  return 'Number of MMP points (durations between 3 and 20 minutes) the regression fitted on. '
       + 'Up to 9 possible. 7+ is a full picture, 4-6 is workable, 2-3 is minimal — '
       + 'a fit through only 2 points has no error to speak of but very little to corroborate it.';
}

function renderOverrideForm() {
  const cp = currentSettings.cpOverrideW ?? '';
  const from = currentSettings.dateFrom || '';
  const to = currentSettings.dateTo || '';
  return `
    <details class="override-panel" ${
      currentSettings.cpOverrideW || currentSettings.dateFrom || currentSettings.dateTo
        ? 'open' : ''
    }>
      <summary>Adjust the fit</summary>
      <form class="override-form" id="override-form">
        <label class="override-form__field">
          <span>CP override (W)</span>
          <input type="number" id="cp-override" min="50" max="600" step="1" value="${cp}" placeholder="e.g. 280">
        </label>
        <label class="override-form__field">
          <span>From</span>
          <input type="date" id="date-from" value="${from}">
        </label>
        <label class="override-form__field">
          <span>To</span>
          <input type="date" id="date-to" value="${to}">
        </label>
        <div class="override-form__actions">
          <button type="submit">Apply</button>
          <button type="button" class="link-button" id="reset-override">Reset</button>
        </div>
      </form>
    </details>
  `;
}

function wireOverrideForm() {
  const form = document.getElementById('override-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cpStr = document.getElementById('cp-override').value.trim();
    const from = document.getElementById('date-from').value;
    const to = document.getElementById('date-to').value;
    const cp = cpStr ? Number(cpStr) : null;
    currentSettings = {
      ...currentSettings,
      cpOverrideW: Number.isFinite(cp) ? cp : null,
      dateFrom: from || null,
      dateTo: to || null,
    };
    await saveSettings(currentSettings);
    renderCurves(currentActivities, { fromCache: true });
  });
  document.getElementById('reset-override').addEventListener('click', async () => {
    currentSettings = {};
    await saveSettings({});
    renderCurves(currentActivities, { fromCache: true });
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
    // Date range is active — no tabs, just draw the (pre-filtered) 90d set.
    draw('last90');
    return;
  }
  tabs.forEach((t) => {
    t.addEventListener('click', () => draw(t.dataset.window));
  });
  draw('last90');
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
  const headerMeta = overrideActive
    ? `CP model · custom override`
    : `CP model · last 90 days, effort-filtered`;

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
        <div data-tooltip="${rmseTooltip(currentFit.rmse)}">
          <dt>RMSE</dt>
          <dd>${currentFit.rmse.toFixed(1)} W</dd>
          <span class="fit-stats__quality ${rmseQuality(currentFit.rmse).cls}">${rmseQuality(currentFit.rmse).label}</span>
        </div>
        <div data-tooltip="${pointsTooltip(currentFit.nPoints)}">
          <dt>Points</dt>
          <dd>${currentFit.nPoints}</dd>
          <span class="fit-stats__quality ${pointsQuality(currentFit.nPoints).cls}">${pointsQuality(currentFit.nPoints).label}</span>
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
                <button type="button" data-window="allTime" role="tab">All-time</button>
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
    const result = predictPower(currentFit, seconds);
    if (!result) {
      out.hidden = false;
      out.innerHTML = `<p class="predict-output__error">Prediction failed.</p>`;
      return;
    }
    out.hidden = false;
    out.innerHTML = `
      <p class="predict-output__label">Predicted for ${formatDuration(seconds)}</p>
      <p class="predict-output__value">${Math.round(result.powerW)}<span class="predict-output__unit">W</span></p>
      <p class="predict-output__band">
        Range ${Math.round(result.low)}–${Math.round(result.high)} W
        ${result.extrapolated ? '<span class="predict-output__flag">extrapolated</span>' : ''}
      </p>
    `;
  });
}

async function handleClearCache() {
  if (!confirm('Clear all cached activity data from this browser?')) return;
  await clearActivities();
  resultsEl.hidden = true;
  resultsEl.innerHTML = '';
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
