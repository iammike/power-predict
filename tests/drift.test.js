import { describe, it, expect } from 'vitest';
import { eftpAt, normalizeForDrift } from '../src/drift.js';

const day = 86400_000;

describe('eftpAt', () => {
  it('returns 0.95 × best 20-min MMP in the backward window', () => {
    const acts = [
      { startTime: 0,        mmp: { 1200: 280 } },
      { startTime: 30 * day, mmp: { 1200: 300 } },
      { startTime: 60 * day, mmp: { 1200: 250 } },
    ];
    expect(eftpAt(acts, 60 * day)).toBeCloseTo(300 * 0.95, 4);
  });

  it('excludes activities outside the window', () => {
    const acts = [
      { startTime: 0,         mmp: { 1200: 999 } }, // 200d old, out
      { startTime: 150 * day, mmp: { 1200: 250 } },
    ];
    expect(eftpAt(acts, 200 * day)).toBeCloseTo(250 * 0.95, 4);
  });

  it('falls back to 15-min × 0.93 when no 20-min data', () => {
    const acts = [{ startTime: 10 * day, mmp: { 900: 290 } }];
    expect(eftpAt(acts, 10 * day)).toBeCloseTo(290 * 0.93, 4);
  });

  it('returns null when neither 20m nor 15m exist', () => {
    expect(eftpAt([{ startTime: 0, mmp: { 60: 350 } }], 0)).toBeNull();
  });
});

describe('normalizeForDrift', () => {
  it('scales an old activity up when current fitness is higher', () => {
    const acts = [
      { startTime: 0,         mmp: { 1200: 200, 300: 240 } }, // eFTP_then ≈ 190
      { startTime: 200 * day, mmp: { 1200: 250 } },           // eFTP_now  ≈ 237.5
    ];
    const { activities, eftpNow } = normalizeForDrift(acts);
    expect(eftpNow).toBeCloseTo(250 * 0.95, 4);
    // First activity scales by 250/200 = 1.25 (within clamp)
    expect(activities[0].mmp[1200]).toBeCloseTo(200 * 1.25, 2);
    expect(activities[0].mmp[300]).toBeCloseTo(240 * 1.25, 2);
    expect(activities[0]._driftScale).toBeCloseTo(1.25, 4);
    // Most recent activity is the eftp_now anchor — scale ≈ 1, passes through
    expect(activities[1].mmp[1200]).toBe(250);
  });

  it('clamps scale to [0.7, 1.3]', () => {
    const acts = [
      { startTime: 0,         mmp: { 1200: 100 } }, // eFTP 95
      { startTime: 200 * day, mmp: { 1200: 400 } }, // eFTP 380, ratio 4.0 → clamp 1.3
    ];
    const { activities } = normalizeForDrift(acts);
    expect(activities[0]._driftScale).toBeCloseTo(1.3, 4);
    expect(activities[0].mmp[1200]).toBeCloseTo(130, 2);
  });

  it('passes activities through unchanged when no eFTP_now is available', () => {
    const acts = [{ startTime: 0, mmp: { 60: 350 } }]; // no 20m/15m
    const { activities, eftpNow } = normalizeForDrift(acts);
    expect(eftpNow).toBeNull();
    expect(activities).toBe(acts);
  });

  it('passes individual activities through when their window has no eFTP', () => {
    const acts = [
      { startTime: 0,         mmp: { 60: 280 } }, // no 20m in window — pass through
      { startTime: 200 * day, mmp: { 1200: 300 } },
    ];
    const { activities } = normalizeForDrift(acts);
    expect(activities[0]).toBe(acts[0]);
    expect(activities[0]._driftScale).toBeUndefined();
  });
});
