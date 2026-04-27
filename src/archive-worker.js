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

  // ------- Parse FIT files -------
  for (const { name, bytes } of pendingFits) {
    let p = name;
    let b = bytes;
    try {
      if (p.endsWith('.gz')) b = gunzipSync(b);
      const activity = await parseFit(b);
      if (activity?.powerStream) {
        const mmp = extractMmp(activity.powerStream);
        self.postMessage({
          type: 'activity',
          startTime: activity.startTime,
          durationS: activity.durationS,
          distanceM: activity.distanceM,
          mmp,
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
