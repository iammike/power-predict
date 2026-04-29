// Web Worker that owns the entire archive ingest pipeline.
//
// Runs on a dedicated thread so the main UI never blocks no matter
// how heavy fflate or fit-file-parser get. We read the file in
// fixed 1 MB slices (rather than file.stream(), whose chunk sizing
// is implementation-defined and was returning huge chunks for very
// large archives), feed them into fflate's streaming Unzip with
// the *sync* UnzipInflate decoder, and parse FIT files as they pop
// out. Progress + activity data flow back to the main thread via
// postMessage.

import { Unzip, UnzipInflate, gunzipSync } from 'fflate';
import { parseFit } from './fit.js';
import { extractMmp } from './mmp.js';

const ACTIVITY_PATH = /^activities\/[^/]+\.fit(\.gz)?$/i;
const ACTIVITIES_CSV = /^activities\.csv$/i;
const CHUNK_BYTES = 1 << 20; // 1 MB

self.onmessage = async (e) => {
  const { type, file } = e.data || {};
  if (type !== 'parse' || !file) return;

  try {
    await parseArchive(file);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};

async function parseArchive(file) {
  const totalBytes = file.size;
  let bytesRead = 0;
  let activitiesSeen = 0;
  let parsedCount = 0;
  let withPower = 0;

  // Buffers per pending activity entry. We can't parse FIT inside
  // ondata because parseFit is synchronous and slow — instead we
  // collect bytes and process after the streaming read completes.
  const pendingFits = [];
  // activities.csv (when present) maps each FIT filename to its
  // public Strava activity ID. Buffered during the unzip stream and
  // parsed once before the FIT loop walks the pending entries.
  let csvBytes = null;

  const post = (extra = {}) =>
    self.postMessage({
      type: 'progress',
      bytesRead,
      totalBytes,
      activitiesSeen,
      parsedCount,
      withPower,
      ...extra,
    });

  // ------- Read + decompress -------
  await new Promise((resolve, reject) => {
    const unzipper = new Unzip((entry) => {
      if (ACTIVITIES_CSV.test(entry.name)) {
        const chunks = [];
        let totalSize = 0;
        entry.ondata = (err, chunk, final) => {
          if (err) { console.warn('csv entry error', err); return; }
          if (chunk) { chunks.push(chunk); totalSize += chunk.length; }
          if (final) {
            csvBytes = new Uint8Array(totalSize);
            let offset = 0;
            for (const c of chunks) { csvBytes.set(c, offset); offset += c.length; }
          }
        };
        entry.start();
        return;
      }
      if (!ACTIVITY_PATH.test(entry.name)) {
        entry.ondata = () => {};
        entry.start();
        return;
      }
      activitiesSeen++;
      const chunks = [];
      let totalSize = 0;
      entry.ondata = (err, chunk, final) => {
        if (err) { console.warn('zip entry error', entry.name, err); return; }
        if (chunk) { chunks.push(chunk); totalSize += chunk.length; }
        if (final) {
          const bytes = new Uint8Array(totalSize);
          let offset = 0;
          for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
          chunks.length = 0;
          pendingFits.push({ name: entry.name, bytes });
        }
      };
      entry.start();
    });
    unzipper.register(UnzipInflate);

    (async () => {
      try {
        let offset = 0;
        while (offset < totalBytes) {
          const end = Math.min(offset + CHUNK_BYTES, totalBytes);
          const slice = file.slice(offset, end);
          const ab = await slice.arrayBuffer();
          const u8 = new Uint8Array(ab);
          unzipper.push(u8, end >= totalBytes);
          offset = end;
          bytesRead = offset;
          post({ phase: 'reading' });
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    })();
  });

  // ------- Parse activities.csv → filename → Strava ID map -------
  // The map keys are normalized: full path (`activities/X.fit.gz`)
  // and basename (`X.fit.gz`). Looking up a FIT entry tries both, so
  // small differences in CSV path formatting don't break linking.
  const idByName = csvBytes ? buildIdMap(csvBytes) : null;

  // ------- Parse FIT files -------
  for (const { name, bytes } of pendingFits) {
    let p = name;
    let b = bytes;
    try {
      if (p.endsWith('.gz')) b = gunzipSync(b);
      const activity = await parseFit(b);
      if (activity?.powerStream) {
        const mmp = extractMmp(activity.powerStream);
        // Average power across the activity's full power stream
        // (including zero / coasting samples) is a coarse proxy for
        // overall intensity. Used to flag low-effort rides that
        // shouldn't anchor the recency-weighted CP fit.
        let totalPower = 0;
        for (let i = 0; i < activity.powerStream.length; i++) {
          totalPower += activity.powerStream[i] || 0;
        }
        const avgPower = activity.powerStream.length
          ? totalPower / activity.powerStream.length
          : 0;
        // Resolve the public Strava activity ID via activities.csv.
        // The number in the FIT filename is the upload ID — globally
        // unique but distinct from the activity ID a user URL uses,
        // so we can't fall back to the filename here.
        const base = name.split('/').pop() || name;
        const stravaId = idByName?.get(name) ?? idByName?.get(base) ?? null;
        self.postMessage({
          type: 'activity',
          startTime: activity.startTime,
          durationS: activity.durationS,
          distanceM: activity.distanceM,
          avgPower,
          mmp,
          stravaId,
        });
        withPower++;
      }
    } catch (err) {
      console.warn('parse failed', name, err);
    }
    parsedCount++;
    if (parsedCount % 5 === 0 || parsedCount === pendingFits.length) {
      post({ phase: 'parsing' });
    }
  }
  pendingFits.length = 0;

  self.postMessage({ type: 'done', activitiesSeen, parsedCount, withPower });
}

export { buildIdMap, parseCsv };

// Build { fullPath, basename → activity_id } from activities.csv.
// Strava export columns shift between versions, so we resolve them
// by header name. We index by both the full Filename column value
// and its basename so lookup tolerates path differences in the FIT
// loop.
function buildIdMap(csvBytes) {
  const text = new TextDecoder().decode(csvBytes);
  const rows = parseCsv(text);
  if (!rows.length) return null;
  const header = rows[0].map((s) => s.trim().toLowerCase());
  const idIdx = header.indexOf('activity id');
  const fnIdx = header.indexOf('filename');
  if (idIdx < 0 || fnIdx < 0) return null;
  const map = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const id = row[idIdx]?.trim();
    const fn = row[fnIdx]?.trim();
    if (!id || !fn) continue;
    map.set(fn, id);
    const base = fn.split('/').pop();
    if (base && base !== fn) map.set(base, id);
  }
  return map;
}

// Tiny CSV parser: handles quoted fields, escaped quotes (""), and
// CRLF or LF line endings. Strava CSVs are small (KBs), so a
// straightforward state machine is fine.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length) {
        row.push(field); rows.push(row); row = []; field = '';
      }
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
