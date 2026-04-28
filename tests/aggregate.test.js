import { describe, it, expect } from 'vitest';
import { rollingBest, recencyWeightedBest, normalizedPower, avgPower } from '../src/aggregate.js';

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

describe('recencyWeightedBest', () => {
  const now = 100 * 86400_000;

  it('returns the raw power of the highest-weighted effort', () => {
    const acts = [
      { startTime: now - 60 * 86400_000, mmp: { 60: 350 } }, // 60d old, weight ≈ 0.37
      { startTime: now - 5  * 86400_000, mmp: { 60: 280 } }, // 5d old, weight ≈ 0.92
    ];
    // 350 × 0.37 ≈ 130 vs 280 × 0.92 ≈ 258 → recent wins; raw value is 280.
    expect(recencyWeightedBest(acts, { halfLifeDays: 42, now })).toEqual({ 60: 280 });
  });

  it('lets an old peak win when the recent value is much lower', () => {
    const acts = [
      { startTime: now - 60 * 86400_000, mmp: { 60: 400 } }, // weight 0.37 → 148
      { startTime: now - 5  * 86400_000, mmp: { 60: 100 } }, // weight 0.92 → 92
    ];
    expect(recencyWeightedBest(acts, { halfLifeDays: 42, now })).toEqual({ 60: 400 });
  });

  it('respects windowDays cutoff', () => {
    const acts = [
      { startTime: now - 200 * 86400_000, mmp: { 60: 999 } },
      { startTime: now - 10  * 86400_000, mmp: { 60: 250 } },
    ];
    expect(recencyWeightedBest(acts, { windowDays: 90, halfLifeDays: 42, now })).toEqual({ 60: 250 });
  });

  it('handles a missing duration gracefully', () => {
    const acts = [
      { startTime: now - 5 * 86400_000, mmp: { 60: 300 } },
      { startTime: now - 5 * 86400_000, mmp: { 300: 250 } },
    ];
    expect(recencyWeightedBest(acts, { halfLifeDays: 42, now })).toEqual({ 60: 300, 300: 250 });
  });
});

describe('normalizedPower', () => {
  it('equals avg power for a flat stream', () => {
    const stream = new Array(120).fill(200);
    expect(normalizedPower(stream)).toBeCloseTo(200, 5);
  });

  it('exceeds avg power for a variable stream', () => {
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
