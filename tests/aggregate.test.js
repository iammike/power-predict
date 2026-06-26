import { describe, it, expect } from 'vitest';
import {
  rollingBest,
  rollingBestWithOwners,
  recencyWeightedBest,
  estimateFtp,
  effortQualityStats,
  normalizedPower,
  avgPower,
  effortGateThreshold,
  passesEffortGate,
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

describe('effort gate', () => {
  it('is flat at the anchor IF for rides up to 1h', () => {
    expect(effortGateThreshold(0.70, 600)).toBe(0.70);
    expect(effortGateThreshold(0.70, 1800)).toBe(0.70);
    expect(effortGateThreshold(0.70, 3600)).toBe(0.70);
  });

  it('decays gently beyond 1h (continuous at the anchor)', () => {
    expect(effortGateThreshold(0.70, 3601)).toBeCloseTo(0.70, 3);
    // 5.5h ride: 0.70 * (3600/19872)^0.06
    expect(effortGateThreshold(0.70, 19872)).toBeCloseTo(0.632, 3);
    expect(effortGateThreshold(0.70, 32400)).toBeLessThan(0.632);
  });

  it('passes a hard 5.5h ride that the flat gate would drop', () => {
    // avg 207 / ftp 300 = 0.69, below flat 0.70 but above the 0.63 long floor
    expect(passesEffortGate(207, 300, 19872, 0.70)).toBe(true);
  });

  it('still drops an easy short ride and an easy long ride', () => {
    expect(passesEffortGate(195, 300, 1800, 0.70)).toBe(false);   // 0.65 @ 30min
    expect(passesEffortGate(165, 300, 19872, 0.70)).toBe(false);  // 0.55 @ 5.5h
  });

  it('is a no-op without a usable ftp/minIF or avgPower', () => {
    expect(passesEffortGate(100, null, 19872, 0.70)).toBe(true);
    expect(passesEffortGate(NaN, 300, 19872, 0.70)).toBe(true);
  });

  it('rollingBest keeps a hard long ride and drops an easy one', () => {
    const acts = [
      { startTime: 1, durationS: 19872, avgPower: 207, mmp: { 14400: 217, 1200: 291 } },
      { startTime: 2, durationS: 19872, avgPower: 165, mmp: { 14400: 170 } },
    ];
    const best = rollingBest(acts, { minIF: 0.70, ftp: 300 });
    expect(best[14400]).toBe(217);
  });

  it('recencyWeightedBest keeps a hard long ride and drops an easy one', () => {
    const acts = [
      { startTime: 1000, durationS: 19872, avgPower: 207, mmp: { 14400: 217 } },
      { startTime: 1000, durationS: 19872, avgPower: 165, mmp: { 10800: 180 } },
    ];
    const best = recencyWeightedBest(acts, { minIF: 0.70, ftp: 300, now: 1000 });
    expect(best[14400]).toBe(217);   // hard ride kept
    expect(best[10800]).toBeUndefined(); // easy ride dropped
  });
});
