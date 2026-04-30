import { describe, it, expect } from 'vitest';
import { computeTss, computeLoadSeries, formMultiplier, tsbBand } from '../src/load.js';

const day = 86_400_000;

describe('computeTss', () => {
  it('returns null without an FTP', () => {
    expect(computeTss({ npW: 200, durationS: 3600 }, null)).toBeNull();
    expect(computeTss({ npW: 200, durationS: 3600 }, 0)).toBeNull();
  });

  it('returns null without a usable NP/avgPower', () => {
    expect(computeTss({ durationS: 3600 }, 250)).toBeNull();
  });

  it('matches the textbook formula on a 1-hour FTP effort (TSS = 100)', () => {
    expect(computeTss({ npW: 250, durationS: 3600 }, 250)).toBeCloseTo(100, 4);
  });

  it('falls back to avgPower when npW is missing', () => {
    expect(computeTss({ avgPower: 200, durationS: 3600 }, 250)).toBeCloseTo(64, 4);
  });

  it('caps absurd values at 600', () => {
    // 4 hours all-out at IF=2 would compute to (4)(4)(100) = 1600; cap.
    expect(computeTss({ npW: 500, durationS: 4 * 3600 }, 250)).toBe(600);
  });
});

describe('computeLoadSeries', () => {
  it('returns zero series when no FTP', () => {
    const out = computeLoadSeries([{ startTime: 0, npW: 200, durationS: 3600 }], null);
    expect(out).toEqual({ ctl: 0, atl: 0, tsb: 0, days: 0, hasFtp: false });
  });

  it('a steady 100 TSS/day rider has CTL ≈ ATL ≈ 100', () => {
    const ftp = 250;
    const now = 60 * day;
    const acts = [];
    for (let d = 0; d < 60; d++) {
      acts.push({ startTime: d * day + 12 * 3600 * 1000, npW: 250, durationS: 3600 });
    }
    const out = computeLoadSeries(acts, ftp, { now });
    expect(out.hasFtp).toBe(true);
    expect(out.ctl).toBeGreaterThan(70);
    expect(out.ctl).toBeLessThan(105);
    expect(Math.abs(out.ctl - out.atl)).toBeLessThan(15);
    // TSB near zero for a stable rider.
    expect(Math.abs(out.tsb)).toBeLessThan(15);
  });

  it('a hard finish bumps ATL faster than CTL → negative TSB', () => {
    const ftp = 250;
    const now = 30 * day;
    const acts = [];
    for (let d = 0; d < 23; d++) {
      acts.push({ startTime: d * day, npW: 200, durationS: 3600 });
    }
    // Hard week to finish
    for (let d = 23; d < 30; d++) {
      acts.push({ startTime: d * day, npW: 280, durationS: 90 * 60 });
    }
    const out = computeLoadSeries(acts, ftp, { now });
    expect(out.tsb).toBeLessThan(0);
  });

  it('a taper raises TSB above zero', () => {
    const ftp = 250;
    const now = 30 * day;
    const acts = [];
    for (let d = 0; d < 23; d++) {
      acts.push({ startTime: d * day, npW: 240, durationS: 90 * 60 });
    }
    // Easy taper week
    for (let d = 23; d < 30; d++) {
      acts.push({ startTime: d * day, npW: 160, durationS: 30 * 60 });
    }
    const out = computeLoadSeries(acts, ftp, { now });
    expect(out.tsb).toBeGreaterThan(0);
  });
});

describe('formMultiplier', () => {
  it('returns 1 when TSB is unknown', () => {
    expect(formMultiplier(NaN)).toBe(1);
    expect(formMultiplier(null)).toBe(1);
  });
  it('returns 1 at TSB = 0', () => {
    expect(formMultiplier(0)).toBeCloseTo(1, 6);
  });
  it('caps at +5% above TSB +25', () => {
    expect(formMultiplier(40)).toBeCloseTo(1.05, 4);
    expect(formMultiplier(25)).toBeCloseTo(1.05, 4);
  });
  it('caps at -5% below TSB -25', () => {
    expect(formMultiplier(-40)).toBeCloseTo(0.95, 4);
    expect(formMultiplier(-25)).toBeCloseTo(0.95, 4);
  });
  it('scales linearly between caps', () => {
    expect(formMultiplier(10)).toBeCloseTo(1.02, 4);
  });
});

describe('tsbBand', () => {
  it('bands TSB by sign and magnitude', () => {
    expect(tsbBand(15)).toBe('fresh');
    expect(tsbBand(0)).toBe('stable');
    expect(tsbBand(-10)).toBe('building');
    expect(tsbBand(-30)).toBe('overloaded');
    expect(tsbBand(NaN)).toBe('unknown');
  });
});
