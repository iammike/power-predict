import { unzipArchive, listActivityEntries, decodeEntry } from './archive.js';
import { parseFit } from './fit.js';
import { extractMmp, DURATIONS_S } from './mmp.js';
import { rollingBest } from './aggregate.js';
import { formatDuration, formatPower } from './format.js';

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

async function handleArchive(file) {
  setProgress(`Unzipping ${file.name}…`);
  const files = await unzipArchive(file);
  const entries = listActivityEntries(files);
  const fitEntries = entries.filter((p) => /\.fit(\.gz)?$/i.test(p));

  setProgress(`Found ${entries.length} activities (${fitEntries.length} FIT). Parsing…`);

  const activityMmps = [];
  let withPower = 0;
  for (let i = 0; i < fitEntries.length; i++) {
    const path = fitEntries[i];
    try {
      const { bytes } = decodeEntry(files, path);
      const activity = await parseFit(bytes);
      if (activity?.powerStream) {
        const mmp = extractMmp(activity.powerStream);
        activityMmps.push({ startTime: activity.startTime, durationS: activity.durationS, mmp });
        withPower++;
      }
    } catch (err) {
      console.warn('parse failed', path, err);
    }
    if (i % 5 === 0 || i === fitEntries.length - 1) {
      setProgress(`Parsed ${i + 1}/${fitEntries.length} (${withPower} with power)…`);
      await tick();
    }
  }

  if (activityMmps.length === 0) {
    setProgress('No power-equipped activities found in the archive.');
    return;
  }

  setProgress(`Done. ${withPower} power activities. Building curve…`);
  renderCurves(activityMmps);
}

function renderCurves(activityMmps) {
  const allTime = rollingBest(activityMmps);
  const last90 = rollingBest(activityMmps, { windowDays: 90 });
  const last30 = rollingBest(activityMmps, { windowDays: 30 });

  const rows = DURATIONS_S
    .filter((d) => allTime[d] !== undefined)
    .map((d) => `
      <tr>
        <td>${formatDuration(d)}</td>
        <td>${last30[d] !== undefined ? formatPower(last30[d]) : '—'}</td>
        <td>${last90[d] !== undefined ? formatPower(last90[d]) : '—'}</td>
        <td>${formatPower(allTime[d])}</td>
      </tr>`)
    .join('');

  resultsEl.innerHTML = `
    <h2>Mean Maximal Power</h2>
    <table class="mmp-table">
      <thead>
        <tr><th>Duration</th><th>Last 30d</th><th>Last 90d</th><th>All-time</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">${activityMmps.length} activities with power processed locally. Nothing has been uploaded.</p>
  `;
  resultsEl.hidden = false;
}

function setProgress(msg) {
  if (!progressEl) return;
  progressEl.textContent = msg;
  progressEl.hidden = false;
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
