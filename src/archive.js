// Streaming Strava-archive ingest.
//
// fflate's `Unzip` lets us push chunks from `file.stream()` and pull
// activity entries out as they complete. We:
//   - never hold the full decompressed archive in memory
//   - drain activity entries through a serial queue with concurrency 1,
//     yielding to the event loop between items so paints land
//   - apply backpressure: stop consuming the zip when the queue is
//     full so we don't pile up gigabytes of decompressed bytes faster
//     than we can parse them

import { Unzip, AsyncUnzipInflate, gunzipSync, strFromU8 } from 'fflate';

const ACTIVITY_PATH = /^activities\/[^/]+\.(fit|tcx|gpx)(\.gz)?$/i;

// Tunables. With ~2 MB FIT files, MAX_QUEUE=4 caps in-flight memory
// at roughly 8-16 MB plus whatever fflate's reader buffers — well
// inside what every browser tolerates.
const MAX_QUEUE = 4;
const READ_PAUSE_MS = 8;

export async function streamArchive(file, { onProgress, onActivity, onCsv } = {}) {
  const totalBytes = file.size;
  let bytesRead = 0;
  let filesSeen = 0;
  let activitiesSeen = 0;

  // Serial drain queue for heavy per-entry work (gunzip + onActivity).
  const queue = [];
  let queueDraining = false;
  let queueResolveDone = null;
  let queueDonePromise = new Promise((r) => { queueResolveDone = r; });
  let pendingDispatchTotal = 0;
  let pendingDispatchDone = 0;

  const tick = () => onProgress?.({
    bytesRead, totalBytes, filesSeen, activitiesSeen,
    queueDepth: queue.length,
  });

  async function drainQueue() {
    if (queueDraining) return;
    queueDraining = true;
    while (queue.length > 0) {
      const job = queue.shift();
      try { await job(); } catch (err) { console.warn('queue job failed', err); }
      pendingDispatchDone++;
      // Yield so the reader can resume and the UI can paint.
      await new Promise((r) => setTimeout(r, 0));
    }
    queueDraining = false;
    if (pendingDispatchDone === pendingDispatchTotal && queueResolveDone) {
      const r = queueResolveDone;
      queueResolveDone = null;
      r();
    }
  }

  function enqueue(job) {
    pendingDispatchTotal++;
    queue.push(job);
    drainQueue(); // fire and forget
  }

  await new Promise((resolve, reject) => {
    const unzipper = new Unzip((entry) => {
      filesSeen++;
      const isActivity = ACTIVITY_PATH.test(entry.name);
      const isActivitiesCsv = entry.name === 'activities.csv';

      if (!isActivity && !isActivitiesCsv) {
        // Drain non-activity entries without allocating.
        entry.ondata = () => {};
        entry.start();
        return;
      }

      if (isActivity) activitiesSeen++;

      const chunks = [];
      let totalSize = 0;
      entry.ondata = (err, chunk, final) => {
        if (err) { console.warn('zip entry error', entry.name, err); return; }
        if (chunk) { chunks.push(chunk); totalSize += chunk.length; }
        if (final) {
          const bytes = concatChunks(chunks, totalSize);
          chunks.length = 0;
          if (isActivity && onActivity) {
            enqueue(async () => {
              try {
                const decoded = await decodeActivity(entry.name, bytes);
                await onActivity(decoded);
              } catch (err) {
                console.warn('activity decode failed', entry.name, err);
              }
            });
          } else if (isActivitiesCsv && onCsv) {
            try { onCsv(strFromU8(bytes)); } catch (e) { console.warn('csv decode failed', e); }
          }
        }
      };
      entry.start();
    });
    unzipper.register(AsyncUnzipInflate);

    (async () => {
      try {
        const reader = file.stream().getReader();
        while (true) {
          // Backpressure: pause reading when the parse queue is full.
          while (queue.length >= MAX_QUEUE) {
            await new Promise((r) => setTimeout(r, READ_PAUSE_MS));
          }
          const { done, value } = await reader.read();
          if (done) {
            unzipper.push(new Uint8Array(0), true);
            break;
          }
          unzipper.push(value);
          bytesRead += value.length;
          tick();
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    })();
  });

  // Wait for the queue to fully drain.
  if (pendingDispatchDone < pendingDispatchTotal) {
    await queueDonePromise;
  }
  return { filesSeen, activitiesSeen, bytesRead };
}

function concatChunks(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function decodeActivity(path, bytes) {
  let p = path;
  let b = bytes;
  if (p.endsWith('.gz')) {
    b = gunzipSync(b);
    p = p.slice(0, -3);
  }
  const ext = p.split('.').pop().toLowerCase();
  const name = p.split('/').pop();
  return { name, ext, bytes: b };
}
