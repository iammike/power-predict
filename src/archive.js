// Strava archive (zip) unpacking. Yields one activity entry at a time so
// the UI can stream progress and we never hold every parsed file in memory
// at once.

import { unzip, gunzipSync, strFromU8 } from 'fflate';

const ACTIVITY_PATH = /^activities\/[^/]+\.(fit|tcx|gpx)(\.gz)?$/i;

export async function unzipArchive(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    unzip(buf, (err, files) => (err ? reject(err) : resolve(files)));
  });
}

export function listActivityEntries(files) {
  const out = [];
  for (const path of Object.keys(files)) {
    if (ACTIVITY_PATH.test(path)) out.push(path);
  }
  return out;
}

// Decode an entry into { name, ext, bytes }. Auto-gunzips .fit.gz / .tcx.gz.
export function decodeEntry(files, path) {
  let bytes = files[path];
  let p = path;
  if (p.endsWith('.gz')) {
    bytes = gunzipSync(bytes);
    p = p.slice(0, -3);
  }
  const ext = p.split('.').pop().toLowerCase();
  const name = p.split('/').pop();
  return { name, ext, bytes };
}

// activities.csv may carry pretty names + manual activity metadata. Useful
// later for activity titles; we ignore it during MMP extraction.
export function readActivitiesCsv(files) {
  const raw = files['activities.csv'];
  return raw ? strFromU8(raw) : null;
}
