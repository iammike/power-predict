import { describe, it, expect } from 'vitest';
import {
  rollingBest,
  rollingBestWithOwners,
  recencyWeightedBest,
  estimateFtp,
  effortQualityStats,
  normalizedPower,
  avgPower,
} from '../src/aggregate.js';

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

describe('rollingBestWithOwners', () => {
  it('attaches the winning activity\'s stravaId to each duration', () => {
    const acts = [
      { startTime: 1, stravaId: 'A', mmp: { 60: 250, 300: 220 } },
      { startTime: 2, stravaId: 'B', mmp: { 60: 300, 300: 200 } },
    ];
    expect(rollingBestWithOwners(acts)).toEqual({
      60: { value: 300, stravaId: 'B', startTime: 2 },
      300: { value: 220, stravaId: 'A', startTime: 1 },
    });
  });

  it('records null stravaId when activity has none', () => {
    const acts = [{ startTime: 1, mmp: { 60: 200 } }];
    expect(rollingBestWithOwners(acts)).toEqual({
      60: { value: 200, stravaId: null, startTime: 1 },
    });
  });
});

describe('recencyWeightedBest with effort filter', () => {
  const now = 100 * 86400_000;

  it('drops activities whose IF falls below the threshold', () => {
    const acts = [
      // 5d old, IF = 280/300 = 0.93 → kept
      { startTime: now - 5 * 86400_000, mmp: { 60: 320 }, avgPower: 280 },
      // 5d old, IF = 150/300 = 0.50 → dropped
      { startTime: now - 5 * 86400_000, mmp: { 60: 350 }, avgPower: 150 },
    ];
    const out = recencyWeightedBest(acts, { halfLifeDays: 42, now, minIF: 0.70, ftp: 300 });
    expect(out).toEqual({ 60: 320 });
  });

  it('includes activities with missing avgPower regardless of filter', () => {
    const acts = [
      { startTime: now - 5 * 86400_000, mmp: { 60: 300 } /* no avgPower */ },
    ];
    const out = recencyWeightedBest(acts, { halfLifeDays: 42, now, minIF: 0.70, ftp: 300 });
    expect(out).toEqual({ 60: 300 });
  });

  it('disables filter when minIF or ftp is missing', () => {
    const acts = [
      { startTime: now - 5 * 86400_000, mmp: { 60: 200 }, avgPower: 100 }, // would be IF=0.33
    ];
    expect(recencyWeightedBest(acts, { halfLifeDays: 42, now })).toEqual({ 60: 200 });
  });
});

describe('estimateFtp', () => {
  it('uses 95% of all-time best 20-min MMP', () => {
    const acts = [
      { mmp: { 1200: 280 } },
      { mmp: { 1200: 295 } },
      { mmp: { 1200: 250 } },
    ];
    expect(estimateFtp(acts)).toBeCloseTo(295 * 0.95, 4);
  });

  it('falls back to 15-min × 0.93 when no 20-min data', () => {
    const acts = [{ mmp: { 900: 300 } }];
    expect(estimateFtp(acts)).toBeCloseTo(300 * 0.93, 4);
  });

  it('returns null when neither is available', () => {
    expect(estimateFtp([{ mmp: { 60: 350 } }])).toBeNull();
  });
});

describe('effortQualityStats', () => {
  it('counts included / excluded / unknown', () => {
    const acts = [
      { avgPower: 220 },           // IF 0.78 → included
      { avgPower: 150 },           // IF 0.53 → excluded
      { /* no avgPower */ },       // → unknown
    ];
    expect(effortQualityStats(acts, { minIF: 0.70, ftp: 281 }))
      .toEqual({ included: 1, excluded: 1, unknown: 1 });
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
