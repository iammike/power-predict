import { describe, it, expect } from 'vitest';
import { extractMmp, dropAnomalies, DURATIONS_S } from '../src/mmp.js';

describe('extractMmp', () => {
  it('returns empty for empty stream', () => {
    expect(extractMmp([])).toEqual({});
  });

  it('flat power stream gives that power at every reachable duration', () => {
    const stream = new Array(120).fill(200);
    const mmp = extractMmp(stream);
    for (const d of DURATIONS_S) {
      if (d <= 120) expect(mmp[d]).toBeCloseTo(200, 5);
    }
    expect(mmp[180]).toBeUndefined();
  });

  it('finds the highest sustained window', () => {
    const stream = new Array(60).fill(150);
    for (let i = 10; i < 30; i++) stream[i] = 400;
    const mmp = extractMmp(stream);
    expect(mmp[15]).toBeCloseTo(400, 5);
    expect(mmp[60]).toBeCloseTo((150 * 40 + 400 * 20) / 60, 5);
  });
});

describe('dropAnomalies', () => {
  it('passes a realistic sprint profile through unchanged', () => {
    const mmp = { 1: 900, 2: 870, 3: 830, 5: 780, 15: 600, 30: 500, 60: 380, 300: 280 };
    expect(dropAnomalies(mmp)).toEqual(mmp);
  });

  it('drops a 1s spike that dwarfs the 5s value', () => {
    const mmp = { 1: 2000, 2: 1250, 3: 950, 5: 800, 30: 500, 60: 400 };
    const out = dropAnomalies(mmp);
    expect(out[1]).toBeUndefined();
    expect(out[5]).toBe(800);
  });

  it('drops short-duration values from a 2-second flatline glitch', () => {
    // Simulate a real-feeling ride that also contains a 2s flatline
    // glitch at 1367W. The 1s/2s/3s values are all corrupted by the
    // flatline; longer durations reflect real efforts.
    const mmp = { 1: 1367, 2: 1367, 3: 978, 5: 667, 30: 500, 60: 420, 300: 320 };
    const out = dropAnomalies(mmp);
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBeUndefined();
    expect(out[3]).toBeUndefined();
    expect(out[30]).toBe(500);
    expect(out[60]).toBe(420);
    expect(out[300]).toBe(320);
  });

  it('preserves longer durations even when shorter ones are flagged', () => {
    const mmp = { 1: 2000, 5: 800, 60: 400, 300: 250, 1200: 220 };
    const out = dropAnomalies(mmp);
    expect(out[60]).toBe(400);
    expect(out[300]).toBe(250);
    expect(out[1200]).toBe(220);
  });

  it('handles missing pairs gracefully', () => {
    expect(dropAnomalies({})).toEqual({});
    expect(dropAnomalies({ 60: 250 })).toEqual({ 60: 250 });
  });
});
