import { describe, it, expect } from 'vitest';
import {
  FEELING_PRESETS,
  DEFAULT_FEELING,
  feelingPreset,
  feelingMultiplier,
} from '../src/feeling.js';

describe('FEELING_PRESETS', () => {
  it('has Normal as a zero-adjustment anchor and DEFAULT_FEELING points at it', () => {
    const normal = FEELING_PRESETS.find((p) => p.id === DEFAULT_FEELING);
    expect(normal).toMatchObject({ id: 'normal', adjPct: 0 });
  });

  it('runs strongest-to-weakest so the dropdown reads top-down', () => {
    const pcts = FEELING_PRESETS.map((p) => p.adjPct);
    expect(pcts).toEqual([...pcts].sort((a, b) => b - a));
  });

  it('every preset has a non-empty label and an integer adjPct', () => {
    for (const p of FEELING_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(Number.isInteger(p.adjPct)).toBe(true);
    }
  });
});

describe('feelingPreset', () => {
  it('resolves a known id to its preset object', () => {
    expect(feelingPreset('detrained')).toMatchObject({ id: 'detrained', adjPct: -10 });
  });

  it('falls back to Normal for an unknown, missing, or nullish id', () => {
    for (const bad of ['nope', undefined, null, '']) {
      expect(feelingPreset(bad).id).toBe('normal');
    }
  });
});

describe('feelingMultiplier', () => {
  it('is exactly 1 for Normal', () => {
    expect(feelingMultiplier('normal')).toBe(1);
  });

  it('is 1 + adjPct/100 for a known preset', () => {
    expect(feelingMultiplier('sharp')).toBeCloseTo(1.03, 10);
    expect(feelingMultiplier('off')).toBeCloseTo(0.94, 10);
  });

  it('falls back to the Normal multiplier for an unknown id', () => {
    expect(feelingMultiplier('bogus')).toBe(1);
  });
});
