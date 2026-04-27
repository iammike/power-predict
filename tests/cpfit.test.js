import { describe, it, expect } from 'vitest';
import { fitCp2, predictPower, mmpToPoints } from '../src/cpfit.js';

// Generate synthetic MMP points from a known CP/W' so we can verify
// the fit recovers them.
function synth(cp, wPrime, durationsS) {
  return durationsS.map((t) => ({ durationS: t, powerW: cp + wPrime / t }));
}

describe('fitCp2', () => {
  it('recovers CP and W\' on noiseless synthetic data', () => {
    const points = synth(280, 22000, [180, 300, 600, 900, 1200]);
    const fit = fitCp2(points);
    expect(fit.cpW).toBeCloseTo(280, 4);
    expect(fit.wPrimeJ).toBeCloseTo(22000, 1);
    expect(fit.rmse).toBeLessThan(0.01);
    expect(fit.nPoints).toBe(5);
  });

  it('returns null when fewer than 2 points fall in the fitting window', () => {
    expect(fitCp2([])).toBeNull();
    expect(fitCp2([{ durationS: 600, powerW: 300 }])).toBeNull();
    // Both points outside the default window
    expect(fitCp2([
      { durationS: 30, powerW: 600 },
      { durationS: 60, powerW: 500 },
    ])).toBeNull();
  });

  it('respects a custom fitting range', () => {
    const all = synth(250, 18000, [60, 180, 600, 1200, 3600]);
    const tight = fitCp2(all, { minS: 300, maxS: 1500 });
    expect(tight.nPoints).toBe(2); // 600 and 1200
    expect(tight.cpW).toBeCloseTo(250, 4);
  });

  it('handles modest noise gracefully', () => {
    const clean = synth(290, 21000, [180, 240, 360, 480, 720, 1080, 1200]);
    // ±2W noise
    const noisy = clean.map((p, i) => ({ ...p, powerW: p.powerW + (i % 2 === 0 ? 2 : -2) }));
    const fit = fitCp2(noisy);
    expect(fit.cpW).toBeCloseTo(290, 0);
    expect(fit.rmse).toBeGreaterThan(0);
    expect(fit.rmse).toBeLessThan(5);
  });
});

describe('predictPower', () => {
  const fit = fitCp2(synth(280, 22000, [180, 300, 600, 900, 1200]));

  it('predicts P = CP + W/t', () => {
    const out = predictPower(fit, 2700); // 45 min
    expect(out.powerW).toBeCloseTo(280 + 22000 / 2700, 3);
  });

  it('flags extrapolation outside the observed range', () => {
    const longer = predictPower(fit, 3600); // 60m, beyond max observed 1200s
    expect(longer.extrapolated).toBe(true);
    expect(longer.high - longer.low).toBeGreaterThan(0);

    const inside = predictPower(fit, 600);
    expect(inside.extrapolated).toBe(false);
  });

  it('returns null for invalid input', () => {
    expect(predictPower(null, 600)).toBeNull();
    expect(predictPower(fit, 0)).toBeNull();
    expect(predictPower(fit, -1)).toBeNull();
    expect(predictPower(fit, NaN)).toBeNull();
  });

  it('confidence band widens as duration moves further outside observed range', () => {
    const just = predictPower(fit, 1500);   // a bit outside
    const far = predictPower(fit, 7200);    // way outside
    expect(far.high - far.low).toBeGreaterThan(just.high - just.low);
  });
});

describe('mmpToPoints', () => {
  it('converts an MMP map to point objects', () => {
    const points = mmpToPoints({ 60: 350, 300: 280 });
    expect(points).toHaveLength(2);
    expect(points.map((p) => p.durationS).sort((a, b) => a - b)).toEqual([60, 300]);
  });

  it('skips invalid values', () => {
    const points = mmpToPoints({ 60: 350, 300: null, 600: undefined });
    expect(points).toHaveLength(1);
  });
});
