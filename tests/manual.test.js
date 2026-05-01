import { describe, it, expect } from 'vitest';
import { synthesizeFit } from '../src/manual.js';
import { predictPower } from '../src/cpfit.js';

describe('synthesizeFit', () => {
  it('returns null for missing or invalid FTP', () => {
    expect(synthesizeFit({})).toBeNull();
    expect(synthesizeFit({ ftpW: 0 })).toBeNull();
    expect(synthesizeFit({ ftpW: -5 })).toBeNull();
  });

  it('calibrates CP so the model returns FTP at 60 min', () => {
    const fit = synthesizeFit({ ftpW: 292 });
    // CP = FTP - W'/3600 with W' = 18000 → CP = 292 - 5 = 287
    expect(fit.cpW).toBeCloseTo(287, 4);
    expect(fit.wPrimeJ).toBe(18_000);
    expect(fit.manual).toBe(true);
    // 2-param hyperbola at 3600 s should equal FTP exactly.
    expect(fit.cpW + fit.wPrimeJ / 3600).toBeCloseTo(292, 4);
  });

  it('predicts FTP at 60 min in the full predict path (no Riegel decay for manual fits)', () => {
    const fit = synthesizeFit({ ftpW: 292 });
    const out = predictPower(fit, 3600);
    expect(out.powerW).toBeCloseTo(292, 1);
    expect(out.decayed).toBe(false);
  });

  it('derives W\' from a 1-min sprint via the 2-param hyperbola seed', () => {
    // CP_seed = 250 × 0.95 = 237.5. Sprint 400 W → W' = (400 - 237.5) × 60 = 9750.
    const fit = synthesizeFit({ ftpW: 250, sprint1minW: 400 });
    expect(fit.wPrimeJ).toBeCloseTo(9750, 1);
    // CP recalibrated to keep 60-min == FTP: 250 - 9750/3600 ≈ 247.29.
    expect(fit.cpW).toBeCloseTo(250 - 9750 / 3600, 3);
    expect(fit.cpW + fit.wPrimeJ / 3600).toBeCloseTo(250, 4);
  });

  it('clamps W\' to the [5 kJ, 40 kJ] envelope', () => {
    expect(synthesizeFit({ ftpW: 250, sprint1minW: 240 }).wPrimeJ).toBe(5_000);
    expect(synthesizeFit({ ftpW: 250, sprint1minW: 1500 }).wPrimeJ).toBe(40_000);
  });

  it('falls back to default W\' when sprint is below the CP seed', () => {
    const fit = synthesizeFit({ ftpW: 300, sprint1minW: 200 });
    expect(fit.wPrimeJ).toBe(18_000);
  });
});
