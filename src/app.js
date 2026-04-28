import { DURATIONS_S } from './mmp.js';
import { rollingBest } from './aggregate.js';
import { renderCurveChart } from './curve-chart.js';
import { formatDuration, formatPower } from './format.js';
import {
  loadActivities,
  saveActivities,
  hasActivity,
  clearActivities,
  activityCount,
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

// Hydrate from IndexedDB on page load — returning visitors see their
// curve instantly without re-uploading.
hydrateFromCache();

async function hydrateFromCache() {
  try {
    const cached = await loadActivities();
    if (cached.length > 0) {
      renderCurves(cached, { fromCache: true });
    }
  } catch (err) {
    console.warn('cache hydrate failed', err);
  }
}

async function handleArchive(file) {
  setProgressPhase('Reading', { bytesRead: 0, totalBytes: file.size });

  const newActivities = [];
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
          const phase = msg.phase === 'parsing' ? 'Parsing'
            : msg.activitiesSeen > 0 ? 'Reading' : 'Reading';
          setProgressPhase(phase, {
            bytesRead: msg.bytesRead,
            totalBytes: msg.totalBytes,
            activitiesSeen: msg.activitiesSeen,
            parsedCount: msg.parsedCount,
            withPower: msg.withPower,
            skipped,
          });
        } else if (msg.type === 'activity') {
          try {
            if (await hasActivity(msg.startTime)) {
              skipped++;
            } else {
              newActivities.push({
                startTime: msg.startTime,
                durationS: msg.durationS,
                distanceM: msg.distanceM,
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
    return;
  }
  worker.terminate();

  if (newActivities.length > 0) {
    setProgress(`Saving ${newActivities.length} new activities to local cache…`);
    await saveActivities(newActivities);
  }

  const all = await loadActivities();
  if (all.length === 0) {
    setProgress(
      `No power-equipped activities found in the archive (${lastActivitiesSeen} activity files seen).`
    );
    return;
  }

  setProgress(
    `Done. ${all.length} activities cached locally (${newActivities.length} new this run, ${skipped} already cached, ${withPower} with power).`
  );
  renderCurves(all);
}

// Throttle progress writes via timestamp (not rAF — rAF doesn't fire
// when the main thread is blocked, leaving the bar permanently stuck).
// Re-query the inner DOM each call rather than caching refs, since
// caching across setProgress() resets was racy.
let lastProgressUpdate = 0;
let phaseStartedAt = null;
let lastPhase = null;
const PROGRESS_THROTTLE_MS = 50;

// Roughly equal wall time for read vs. parse on a typical archive,
// so we split the unified bar 50/50. Tweakable.
const READ_WEIGHT = 0.5;

function setProgressPhase(phase, payload) {
  if (!progressEl) return;
  const now = performance.now ? performance.now() : Date.now();
  // Reset phase timer on phase change, and on a fresh run (Reading
  // with bytesRead=0) so ETA doesn't carry over from a previous drop.
  const isFreshRun = phase === 'Reading' && !payload.bytesRead;
  if (lastPhase !== phase || isFreshRun) {
    lastPhase = phase;
    phaseStartedAt = now;
  }
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

  // ETA from phase elapsed and current fraction. Suppressed for the
  // first few percent where the slope is too noisy to extrapolate.
  const phaseFrac = isParsing ? parseFrac : readFrac;
  let etaText = '';
  if (phaseFrac > 0.05 && phaseFrac < 0.99) {
    const elapsed = (now - phaseStartedAt) / 1000;
    const remaining = (elapsed / phaseFrac) * (1 - phaseFrac);
    etaText = ` · ${formatEta(remaining)} remaining`;
  }

  const textEl = progressEl.querySelector('.progress__text');
  const fillEl = progressEl.querySelector('.progress__bar-fill');
  if (textEl) textEl.textContent = `${phaseDetail}${etaText}`;
  if (fillEl) fillEl.style.width = `${overall}%`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 5) return '<5s';
  if (seconds < 90) return `~${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `~${m} min`;
  const h = Math.floor(seconds / 3600);
  const mm = Math.round((seconds - h * 3600) / 60);
  return mm ? `~${h}h ${mm}m` : `~${h}h`;
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
  const allTime = rollingBest(activityMmps);
  const last90 = rollingBest(activityMmps, { windowDays: 90 });
  const last30 = rollingBest(activityMmps, { windowDays: 30 });
  currentMmpByWindow = { last30, last90, allTime };

  // Fit CP/W' on the 90-day curve (falls back to all-time if too sparse).
  currentFit = fitCp2(mmpToPoints(last90)) || fitCp2(mmpToPoints(allTime));

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
      <span class="results-head__meta">Watts · by duration</span>
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
}

function wireCurveChart() {
  const container = document.getElementById('curve-chart');
  if (!container || !currentFit) return;
  const tabs = document.querySelectorAll('[data-window]');
  const drawWindow = (key) => {
    renderCurveChart(container, {
      mmp: currentMmpByWindow[key] || {},
      fit: currentFit,
    });
    tabs.forEach((t) => t.classList.toggle('is-active', t.dataset.window === key));
  };
  tabs.forEach((t) => {
    t.addEventListener('click', () => drawWindow(t.dataset.window));
  });
  drawWindow('last90');
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

  return `
    <section class="predict">
      <header class="results-head">
        <h2>Predict</h2>
        <span class="results-head__meta">Critical-power model · last 90 days</span>
      </header>

      <dl class="fit-stats">
        <div><dt>CP</dt><dd>${formatPower(currentFit.cpW)}</dd></div>
        <div><dt>W'</dt><dd>${(currentFit.wPrimeJ / 1000).toFixed(1)} kJ</dd></div>
        <div><dt>RMSE</dt><dd>${currentFit.rmse.toFixed(1)} W</dd></div>
        <div><dt>Points</dt><dd>${currentFit.nPoints}</dd></div>
      </dl>

      <div class="curve-chart-section">
        <header class="curve-chart-head">
          <span class="curve-chart-title">Power-duration curve</span>
          <div class="curve-window-tabs" role="tablist">
            <button type="button" data-window="last30" role="tab">Last 30d</button>
            <button type="button" data-window="last90" role="tab" class="is-active">Last 90d</button>
            <button type="button" data-window="allTime" role="tab">All-time</button>
          </div>
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
