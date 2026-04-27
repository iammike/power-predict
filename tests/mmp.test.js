import { describe, it, expect } from 'vitest';
import { extractMmp, DURATIONS_S } from '../src/mmp.js';

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
    expect(mmp[20]).toBeCloseTo(400, 5);
    expect(mmp[60]).toBeCloseTo((150 * 40 + 400 * 20) / 60, 5);
  });
});
