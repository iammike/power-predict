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

  it('predicts P = CP + W\'/t inside the CP window when decay is disabled', () => {
    const out = predictPower(fit, 600, { decay: false });
    expect(out.powerW).toBeCloseTo(280 + 22000 / 600, 3);
    expect(out.decayed).toBe(false);
  });

  it('applies Riegel fatigue decay beyond the decay threshold', () => {
    const out = predictPower(fit, 3600); // 60 min
    // anchor at 20 min (no longer-duration data on this fit):
    //   anchor power = 280 + 22000/1200 = 298.33
    //   decay factor = (1200/3600)^0.10 ≈ 0.8959
    //   expected = 298.33 × 0.8959 ≈ 267.3
    expect(out.decayed).toBe(true);
    expect(out.powerW).toBeCloseTo(298.333 * (1200 / 3600) ** 0.10, 2);
    expect(out.powerW).toBeLessThan(fit.cpW);
  });

  it('only uses an observed-MMP anchor when it exceeds the model', () => {
    // Case A: long observed MMP is BELOW model — use threshold anchor.
    const fitLowLong = fitCp2([
      ...synth(280, 22000, [180, 300, 600, 900, 1200]),
      { durationS: 3600, powerW: 200 }, // low-effort 1h base ride
    ]);
    const lowOut = predictPower(fitLowLong, 7200);
    const expectedThresholdAnchored = (280 + 22000 / 1200) * (1200 / 7200) ** 0.10;
    expect(lowOut.powerW).toBeCloseTo(expectedThresholdAnchored, 2);

    // Case B: long observed MMP EXCEEDS model — anchor on it.
    const fitHighLong = fitCp2([
      ...synth(280, 22000, [180, 300, 600, 900, 1200]),
      { durationS: 3600, powerW: 290 }, // genuinely strong 1h
    ]);
    const highOut = predictPower(fitHighLong, 7200);
    expect(highOut.powerW).toBeCloseTo(290 * (3600 / 7200) ** 0.10, 2);
  });

  it('never predicts below a real observation at the same duration', () => {
    // 45-min observed of 242 W in a fit whose 90d CP came out lowish.
    // Even with decay, the prediction should not undercut a real ride
    // at the exact target duration.
    const lowFit = fitCp2([
      ...synth(220, 14000, [180, 300, 600, 900, 1200]),
      { durationS: 2700, powerW: 242 },
      { durationS: 14400, powerW: 150 }, // long low-effort ride
    ]);
    const out = predictPower(lowFit, 2700);
    expect(out.powerW).toBeGreaterThanOrEqual(242);
  });

  it('anchors closer to target when intermediate observations exceed model', () => {
    // Same low fit, but predict 60 min — should anchor on the 45-min
    // observation rather than the threshold or the 4h ride.
    const lowFit = fitCp2([
      ...synth(220, 14000, [180, 300, 600, 900, 1200]),
      { durationS: 2700, powerW: 242 },   // 45 min above model
      { durationS: 14400, powerW: 150 },  // 4h below model — ignored
    ]);
    const out = predictPower(lowFit, 3600);
    // Should anchor at (2700, 242) and decay to 3600.
    expect(out.powerW).toBeCloseTo(242 * (2700 / 3600) ** 0.10, 1);
  });

  it('respects an explicit decay override', () => {
    const aggressive = predictPower(fit, 7200, { decay: { fromS: 600, k: 0.15 } });
    const standard = predictPower(fit, 7200);
    expect(aggressive.powerW).toBeLessThan(standard.powerW);
  });

  it('does not decay below the threshold', () => {
    const out = predictPower(fit, 900); // 15 min, inside CP window
    expect(out.decayed).toBe(false);
    expect(out.powerW).toBeCloseTo(280 + 22000 / 900, 3);
  });

  it('flags extrapolation outside the observed range', () => {
    const longer = predictPower(fit, 3600);
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
    const just = predictPower(fit, 1500);
    const far = predictPower(fit, 7200);
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
