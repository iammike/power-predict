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

  // Build a 1Hz power stream and decide whether this is a real
  // power-meter recording. Three failure modes to filter out:
  //   1. No power field at all (typical for non-power devices).
  //   2. Power field present but always 0 (some FIT writers do this).
  //   3. Power field with sparse low non-zero values from
  //      speed-or-HR-derived "estimated power" — looks numeric but
  //      isn't a power meter. Filtered by requiring a non-trivial
  //      mean across the whole activity.
  const powerStream = new Float32Array(durationS);
  let totalPower = 0;
  let powerSamples = 0;
  let nonZeroSamples = 0;
  for (const r of records) {
    if (typeof r.power !== 'number') continue;
    const idx = Math.round((+new Date(r.timestamp) - t0) / 1000);
    if (idx >= 0 && idx < durationS) powerStream[idx] = r.power;
    powerSamples++;
    totalPower += r.power;
    if (r.power > 0) nonZeroSamples++;
  }
  const minNonZero = Math.max(60, Math.floor(durationS * 0.05));
  const meanPower = powerSamples ? totalPower / powerSamples : 0;
  // Real rides easily exceed 30 W mean (Z1 spinning is ≥ 100 W for
  // most riders); estimated-power activities hover near zero.
  const MEAN_POWER_FLOOR_W = 30;
  if (nonZeroSamples < minNonZero || meanPower < MEAN_POWER_FLOOR_W) {
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
