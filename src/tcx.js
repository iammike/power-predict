// TCX file → { startTime, durationS, distanceM, powerStream } extraction.
//
// Garmin's TCX is XML. Power lives in
//   <Trackpoint>
//     <Time>...</Time>
//     <DistanceMeters>...</DistanceMeters>
//     <Extensions><ns:TPX><ns:Watts>NNN</ns:Watts></ns:TPX></Extensions>
//   </Trackpoint>
// where the Activity Extensions namespace prefix varies by writer.
//
// Older Strava archives ship a meaningful share of activities as TCX
// (Garmin Connect imports, third-party tools). We parse them exactly
// the way we parse FIT: build a 1 Hz power stream rounded by timestamp,
// require enough non-zero samples to call it a real power recording,
// and hand back the same activity shape.

const POWER_TAG_RE = /<(?:[A-Za-z0-9_]+:)?Watts[^>]*>([^<]+)<\/(?:[A-Za-z0-9_]+:)?Watts>/;

export function parseTcx(bytes) {
  const text = typeof bytes === 'string'
    ? bytes
    : new TextDecoder('utf-8').decode(bytes);
  const trackpoints = extractTrackpoints(text);
  if (trackpoints.length === 0) return null;

  const t0 = trackpoints[0].t;
  const tEnd = trackpoints[trackpoints.length - 1].t;
  const durationS = Math.max(1, Math.round((tEnd - t0) / 1000) + 1);

  const powerStream = new Float32Array(durationS);
  let nonZeroSamples = 0;
  let lastDistance = null;
  for (const tp of trackpoints) {
    if (typeof tp.distance === 'number') lastDistance = tp.distance;
    if (typeof tp.power !== 'number') continue;
    const idx = Math.round((tp.t - t0) / 1000);
    if (idx >= 0 && idx < durationS) powerStream[idx] = tp.power;
    if (tp.power > 0) nonZeroSamples++;
  }

  const minNonZero = Math.max(60, Math.floor(durationS * 0.05));
  if (nonZeroSamples < minNonZero) {
    return { startTime: t0, durationS, distanceM: lastDistance, powerStream: null };
  }
  return { startTime: t0, durationS, distanceM: lastDistance, powerStream };
}

// String-scan instead of building a DOM tree. Web Workers in
// modern browsers ship DOMParser, but TCX files can be tens of MB
// per activity and the regex pass is significantly faster on the
// shapes we care about.
function extractTrackpoints(text) {
  const out = [];
  const tpRe = /<Trackpoint[^>]*>([\s\S]*?)<\/Trackpoint>/g;
  let m;
  while ((m = tpRe.exec(text)) !== null) {
    const inner = m[1];
    const time = matchTag(inner, 'Time');
    if (!time) continue;
    const t = Date.parse(time);
    if (Number.isNaN(t)) continue;
    const distanceText = matchTag(inner, 'DistanceMeters');
    const distance = distanceText !== null ? Number(distanceText) : null;
    const powerMatch = inner.match(POWER_TAG_RE);
    const power = powerMatch ? Number(powerMatch[1]) : null;
    out.push({
      t,
      distance: Number.isFinite(distance) ? distance : null,
      power: Number.isFinite(power) ? power : null,
    });
  }
  return out;
}

function matchTag(text, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`);
  const m = text.match(re);
  return m ? m[1].trim() : null;
}
