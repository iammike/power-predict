import { streamArchive } from './archive.js';
import { parseFit } from './fit.js';
import { extractMmp, DURATIONS_S } from './mmp.js';
import { rollingBest } from './aggregate.js';
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
  let parsedCount = 0;
  let withPower = 0;
  let skipped = 0;
  let lastTotalActivities = 0;

  const onActivity = async ({ name, ext, bytes }) => {
    if (ext !== 'fit') return; // TCX/GPX in a follow-up issue
    try {
      const activity = await parseFit(bytes);
      parsedCount++;
      if (activity?.powerStream) {
        if (await hasActivity(activity.startTime)) {
          skipped++;
        } else {
          const mmp = extractMmp(activity.powerStream);
          newActivities.push({
            startTime: activity.startTime,
            durationS: activity.durationS,
            distanceM: activity.distanceM,
            mmp,
          });
        }
        withPower++;
      }
    } catch (err) {
      console.warn('parse failed', name, err);
    }
  };

  const onProgress = ({ bytesRead, totalBytes, activitiesSeen }) => {
    const phase = activitiesSeen > 0 ? 'Reading + parsing' : 'Reading';
    lastTotalActivities = activitiesSeen;
    setProgressPhase(phase, {
      bytesRead,
      totalBytes,
      activitiesSeen,
      parsedCount,
      withPower,
      skipped,
    });
  };

  try {
    await streamArchive(file, { onProgress, onActivity });
  } catch (err) {
    console.error('archive stream failed', err);
    setProgress(`Archive read failed: ${err.message || err}`);
    return;
  }

  if (newActivities.length > 0) {
    setProgress(`Saving ${newActivities.length} new activities to local cache…`);
    await saveActivities(newActivities);
  }

  const all = await loadActivities();
  if (all.length === 0) {
    setProgress(
      `No power-equipped activities found in the archive (${lastTotalActivities} activity files seen).`
    );
    return;
  }

  setProgress(
    `Done. ${all.length} activities cached locally (${newActivities.length} new this run, ${skipped} already cached, ${withPower} with power).`
  );
  renderCurves(all);
}

// Progress UI is updated at most once per animation frame and writes
// directly to a cached text node + bar-fill element instead of
// rebuilding innerHTML — calling this on every fflate chunk would
// otherwise paint-storm the page into unresponsiveness.
let progressTextNode = null;
let progressBarFill = null;
let progressFrameQueued = false;
let progressLatest = null;

function ensureProgressDom() {
  if (!progressEl) return;
  if (progressTextNode && progressBarFill && progressEl.contains(progressTextNode)) return;
  progressEl.innerHTML = `
    <span class="progress__text"></span>
    <span class="progress__bar"><span class="progress__bar-fill"></span></span>
  `;
  progressTextNode = progressEl.querySelector('.progress__text');
  progressBarFill = progressEl.querySelector('.progress__bar-fill');
}

function setProgressPhase(phase, payload) {
  if (!progressEl) return;
  ensureProgressDom();
  progressEl.hidden = false;
  progressLatest = { phase, payload };
  if (progressFrameQueued) return;
  progressFrameQueued = true;
  requestAnimationFrame(() => {
    progressFrameQueued = false;
    if (!progressLatest) return;
    const { phase, payload: p } = progressLatest;
    const pct = p.totalBytes ? Math.min(100, (p.bytesRead / p.totalBytes) * 100) : 0;
    const readPart = `${phase}: ${formatBytes(p.bytesRead)} / ${formatBytes(p.totalBytes)} (${pct.toFixed(0)}%)`;
    const parsePart = p.activitiesSeen
      ? ` · ${p.parsedCount}/${p.activitiesSeen} parsed${p.withPower ? `, ${p.withPower} with power` : ''}${p.skipped ? `, ${p.skipped} cached` : ''}`
      : '';
    progressTextNode.textContent = `${readPart}${parsePart}`;
    progressBarFill.style.width = `${pct}%`;
  });
}

function setProgress(msg) {
  if (!progressEl) return;
  // Reset to plain-text mode so subsequent setProgressPhase rebuilds.
  progressTextNode = null;
  progressBarFill = null;
  progressEl.textContent = msg;
  progressEl.hidden = false;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// Held in module scope so the predict form can read it on submit.
let currentFit = null;

function renderCurves(activityMmps, { fromCache = false } = {}) {
  const allTime = rollingBest(activityMmps);
  const last90 = rollingBest(activityMmps, { windowDays: 90 });
  const last30 = rollingBest(activityMmps, { windowDays: 30 });

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
