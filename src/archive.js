// Streaming Strava-archive ingest.
//
// fflate's `Unzip` lets us push chunks from `file.stream()` and pull
// activity entries out as they complete, so we can report progress
// smoothly and start parsing FIT files before the rest of the zip
// has even been read. Important when the archive is multiple GB.

// Sync UnzipInflate runs decompression on the main thread chunk by
// chunk, yielding to the event loop between chunks via the reader's
// await. AsyncUnzipInflate spawns a Web Worker via a Blob URL; that
// path appears to deadlock when bundled by esbuild for some chunks of
// large archives, so we're avoiding it. Real Web Worker offload is
// tracked in issue #9.
import { Unzip, UnzipInflate, gunzipSync, strFromU8 } from 'fflate';

const ACTIVITY_PATH = /^activities\/[^/]+\.(fit|tcx|gpx)(\.gz)?$/i;

// Stream an archive. Calls `onProgress({ bytesRead, totalBytes,
// filesSeen, activitiesSeen })` as bytes flow through, and
// `onActivity({ name, ext, bytes })` for each activity entry as it
// finishes decompressing. `onCsv(text)` receives `activities.csv`
// content if present.
//
// Resolves with summary counts when the whole archive has been
// streamed and every activity callback has resolved.
export async function streamArchive(file, { onProgress, onActivity, onCsv } = {}) {
  const totalBytes = file.size;
  let bytesRead = 0;
  let filesSeen = 0;
  let activitiesSeen = 0;
  const pending = [];

  const tick = () => onProgress?.({ bytesRead, totalBytes, filesSeen, activitiesSeen });

  await new Promise((resolve, reject) => {
    const unzipper = new Unzip((entry) => {
      filesSeen++;
      const isActivity = ACTIVITY_PATH.test(entry.name);
      const isActivitiesCsv = entry.name === 'activities.csv';

      if (!isActivity && !isActivitiesCsv) {
        // Non-activity entries: we still have to drain them to keep
        // the stream healthy, but we don't allocate or process.
        entry.ondata = () => {};
        entry.start();
        return;
      }

      if (isActivity) activitiesSeen++;

      const chunks = [];
      let totalSize = 0;
      entry.ondata = (err, chunk, final) => {
        if (err) {
          // Non-fatal — skip this entry.
          console.warn('zip entry error', entry.name, err);
          return;
        }
        if (chunk) {
          chunks.push(chunk);
          totalSize += chunk.length;
        }
        if (final) {
          const bytes = concatChunks(chunks, totalSize);
          if (isActivity && onActivity) {
            pending.push(
              decodeActivity(entry.name, bytes)
                .then(onActivity)
                .catch((err) => console.warn('activity decode failed', entry.name, err))
            );
          } else if (isActivitiesCsv && onCsv) {
            try { onCsv(strFromU8(bytes)); } catch (e) { console.warn('csv decode failed', e); }
          }
        }
      };
      entry.start();
    });
    unzipper.register(UnzipInflate);

    (async () => {
      try {
        const reader = file.stream().getReader();
        while (true) {
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

  await Promise.all(pending);
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
