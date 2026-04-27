import { describe, it, expect } from 'vitest';
import { rollingBest, normalizedPower, avgPower } from '../src/aggregate.js';

describe('rollingBest', () => {
  it('takes the max across activities at each duration', () => {
    const acts = [
      { startTime: 1, mmp: { 60: 250, 300: 220 } },
      { startTime: 2, mmp: { 60: 300, 300: 200 } },
    ];
    expect(rollingBest(acts)).toEqual({ 60: 300, 300: 220 });
  });

  it('respects a windowDays cutoff', () => {
    const now = 100 * 86400_000;
    const acts = [
      { startTime: now - 200 * 86400_000, mmp: { 60: 999 } }, // out of window
      { startTime: now - 10 * 86400_000, mmp: { 60: 250 } },
    ];
    expect(rollingBest(acts, { windowDays: 90, now })).toEqual({ 60: 250 });
  });
});

describe('normalizedPower', () => {
  it('equals avg power for a flat stream', () => {
    const stream = new Array(120).fill(200);
    expect(normalizedPower(stream)).toBeCloseTo(200, 5);
  });

  it('exceeds avg power for a variable stream', () => {
    // 60s @ 100W / 60s @ 300W blocks — variability above the 30s smoothing window
    const stream = [];
    for (let block = 0; block < 6; block++) {
      const w = block % 2 === 0 ? 100 : 300;
      for (let i = 0; i < 60; i++) stream.push(w);
    }
    const np = normalizedPower(stream);
    const ap = avgPower(stream);
    expect(np).toBeGreaterThan(ap);
  });
});
