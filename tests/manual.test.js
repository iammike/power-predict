import { describe, it, expect } from 'vitest';
import { synthesizeFit } from '../src/manual.js';

describe('synthesizeFit', () => {
  it('returns null for missing or invalid FTP', () => {
    expect(synthesizeFit({})).toBeNull();
    expect(synthesizeFit({ ftpW: 0 })).toBeNull();
    expect(synthesizeFit({ ftpW: -5 })).toBeNull();
  });

  it('CP is 0.95 × FTP and W\' falls back to 18 kJ without a sprint number', () => {
    const fit = synthesizeFit({ ftpW: 250 });
    expect(fit.cpW).toBeCloseTo(237.5, 4);
    expect(fit.wPrimeJ).toBe(18_000);
    expect(fit.manual).toBe(true);
  });

  it('derives W\' from a 1-min sprint via the 2-param hyperbola', () => {
    // CP = 250 × 0.95 = 237.5. Sprint 400 W → W' = (400 - 237.5) × 60 = 9750
    const fit = synthesizeFit({ ftpW: 250, sprint1minW: 400 });
    expect(fit.wPrimeJ).toBeCloseTo(9750, 1);
  });

  it('clamps W\' to the [5 kJ, 40 kJ] envelope', () => {
    // Sprint slightly above CP → tiny W' → clamp to 5 kJ.
    expect(synthesizeFit({ ftpW: 250, sprint1minW: 240 }).wPrimeJ).toBe(5_000);
    // Sprint way above CP → huge W' → clamp to 40 kJ.
    expect(synthesizeFit({ ftpW: 250, sprint1minW: 1500 }).wPrimeJ).toBe(40_000);
  });

  it('falls back to default when sprint number is below CP (nonsense)', () => {
    const fit = synthesizeFit({ ftpW: 300, sprint1minW: 200 });
    expect(fit.wPrimeJ).toBe(18_000);
  });
});
