import { describe, it, expect } from 'vitest';
import { parseTcx } from '../src/tcx.js';

function makeTcx({ start, samples }) {
  const points = samples.map(({ offsetS, watts, distance }) => {
    const ts = new Date(start + offsetS * 1000).toISOString();
    return `
      <Trackpoint>
        <Time>${ts}</Time>
        ${distance != null ? `<DistanceMeters>${distance}</DistanceMeters>` : ''}
        <Extensions>
          <ns3:TPX xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
            ${watts != null ? `<ns3:Watts>${watts}</ns3:Watts>` : ''}
          </ns3:TPX>
        </Extensions>
      </Trackpoint>`;
  }).join('');
  return `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity><Lap><Track>${points}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
}

describe('parseTcx', () => {
  it('builds a 1 Hz power stream from trackpoints', () => {
    const start = Date.parse('2024-01-01T10:00:00Z');
    const samples = [];
    for (let i = 0; i < 120; i++) samples.push({ offsetS: i, watts: 200 + i, distance: i * 5 });
    const xml = makeTcx({ start, samples });
    const out = parseTcx(new TextEncoder().encode(xml));
    expect(out).not.toBeNull();
    expect(out.startTime).toBe(start);
    expect(out.durationS).toBe(120);
    expect(out.distanceM).toBe(595);
    expect(out.powerStream.length).toBe(120);
    expect(out.powerStream[0]).toBe(200);
    expect(out.powerStream[119]).toBe(319);
  });

  it('returns powerStream:null when too few non-zero samples', () => {
    // 200s activity, only 30 non-zero samples → below the 60s floor
    const start = Date.parse('2024-01-01T10:00:00Z');
    const samples = [];
    for (let i = 0; i < 200; i++) samples.push({ offsetS: i, watts: i < 30 ? 250 : 0 });
    const out = parseTcx(makeTcx({ start, samples }));
    expect(out.powerStream).toBeNull();
    expect(out.durationS).toBe(200);
  });

  it('returns null on empty / invalid XML', () => {
    expect(parseTcx('')).toBeNull();
    expect(parseTcx('<TrainingCenterDatabase></TrainingCenterDatabase>')).toBeNull();
  });

  it('handles the unprefixed <Watts> tag form some writers emit', () => {
    const start = Date.parse('2024-01-01T10:00:00Z');
    const samples = [];
    for (let i = 0; i < 80; i++) {
      const ts = new Date(start + i * 1000).toISOString();
      samples.push(`
        <Trackpoint>
          <Time>${ts}</Time>
          <Extensions><TPX><Watts>${250}</Watts></TPX></Extensions>
        </Trackpoint>`);
    }
    const xml = `<TrainingCenterDatabase><Activities><Activity><Lap><Track>${samples.join('')}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const out = parseTcx(xml);
    expect(out.powerStream).not.toBeNull();
    expect(out.powerStream[0]).toBe(250);
  });
});
