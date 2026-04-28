// FIT file -> { startTime, durationS, distanceM, powerStream } extraction.
// fit-file-parser ships as CommonJS; esbuild bundles it for the browser.

import FitParser from 'fit-file-parser';

const parser = new FitParser({
  force: true,
  speedUnit: 'm/s',
  lengthUnit: 'm',
  temperatureUnit: 'celsius',
  elapsedRecordField: true,
  mode: 'list',
});

export function parseFit(bytes) {
  return new Promise((resolve, reject) => {
    parser.parse(bytes.buffer ? bytes.buffer : bytes, (err, data) => {
      if (err) return reject(err);
      resolve(toActivity(data));
    });
  });
}

function toActivity(data) {
  const records = data.records || [];
  if (records.length === 0) return null;

  // Build a 1Hz power stream. FIT records are typically 1Hz already, but
  // we re-sample by rounding timestamps to handle gaps and >1Hz devices.
  const t0 = +new Date(records[0].timestamp);
  const tEnd = +new Date(records[records.length - 1].timestamp);
  const durationS = Math.max(1, Math.round((tEnd - t0) / 1000) + 1);

  // Build a 1Hz power stream and count how many samples actually
  // carry positive power. Some FIT files written by non-power devices
  // include power=0 in every record, which `typeof === 'number'` would
  // count as "has power". Require enough non-zero samples to call it
  // a real power-meter recording — at least 60 seconds' worth, and at
  // least 5% of the activity's duration. Otherwise treat as no power.
  const powerStream = new Float32Array(durationS);
  let nonZeroSamples = 0;
  for (const r of records) {
    if (typeof r.power !== 'number') continue;
    const idx = Math.round((+new Date(r.timestamp) - t0) / 1000);
    if (idx >= 0 && idx < durationS) powerStream[idx] = r.power;
    if (r.power > 0) nonZeroSamples++;
  }
  const minSamples = Math.max(60, Math.floor(durationS * 0.05));
  if (nonZeroSamples < minSamples) {
    return { startTime: t0, durationS, distanceM: lastDistance(records), powerStream: null };
  }

  return {
    startTime: t0,
    durationS,
    distanceM: lastDistance(records),
    powerStream,
  };
}

function lastDistance(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (typeof records[i].distance === 'number') return records[i].distance;
  }
  return null;
}
