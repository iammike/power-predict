import { describe, it, expect, vi, afterEach } from 'vitest';
// app.js fires hydrateFromCache() at module scope (side effect of import,
// not of anything in this file) -- without a real IDB it fails safely into
// a caught rejection, but this keeps that path quiet.
import 'fake-indexeddb/auto';
import {
  formatBytes, renderMmpCell, latestActivityLabel, allTimeLabel,
  rmseQuality, pointsQuality,
  cpQuality, cpTooltip, wPrimeQuality, wPrimeTooltip,
  formatTsb, usesDefaultK, fatigueValue, fatigueQuality, fatigueTooltip,
  combinedFitQuality, combinedFitTooltip,
  eftpWindowLabel, eftpTooltip, formQuality, formTooltip,
} from '../src/app.js';

describe('formatBytes', () => {
  it('formats sub-KB sizes as whole bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats KB/MB/GB with one decimal once the magnitude drops under 10 units', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024 * 5)).toBe('5.0 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GB');
  });

  it('drops the decimal once the magnitude is 10 or more units', () => {
    expect(formatBytes(1024 * 20)).toBe('20 KB');
  });

  it('handles non-finite and negative inputs without throwing', () => {
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(-500)).toBe('-500 B');
  });
});

describe('renderMmpCell', () => {
  const parse = (html) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
  };

  it('renders an em dash when there is no owner or no numeric value', () => {
    expect(renderMmpCell(null, null)).toBe('—');
    expect(renderMmpCell({ value: 'not a number' }, null)).toBe('—');
  });

  it('renders bare wattage with no stravaId and no date', () => {
    const el = parse(renderMmpCell({ value: 300 }, null));
    expect(el.textContent).toBe('300 W');
    expect(el.querySelector('a, span')).toBeNull();
  });

  it('renders a tooltip span when a date is known but there is no stravaId', () => {
    const startTime = new Date('2026-03-15T12:00:00').getTime();
    const el = parse(renderMmpCell({ value: 300, startTime }, null));
    const span = el.querySelector('span[data-tooltip]');
    expect(span).not.toBeNull();
    expect(span.textContent).toBe('300 W');
    const expectedDate = new Date(startTime)
      .toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    expect(span.getAttribute('data-tooltip')).toBe(expectedDate);
  });

  it('renders a Strava deep link when stravaId is present, with a date+Strava tooltip', () => {
    const startTime = new Date('2026-03-15T12:00:00').getTime();
    const el = parse(renderMmpCell({ value: 300, startTime, stravaId: '123456' }, null));
    const link = el.querySelector('a.mmp-link');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('https://www.strava.com/activities/123456');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(link.textContent).toBe('300 W');
    const expectedDate = new Date(startTime).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    expect(link.getAttribute('data-tooltip')).toBe(`${expectedDate} · open on Strava`);
  });

  it('links to Strava with a generic tooltip when no date is known', () => {
    const el = parse(renderMmpCell({ value: 300, stravaId: '123456' }, null));
    const link = el.querySelector('a.mmp-link');
    expect(link.getAttribute('data-tooltip')).toBe('Open this activity on Strava');
  });

  it('appends a NEW badge when the activity is in newSyncIds', () => {
    const newSyncIds = new Set(['123456']);
    const el = parse(renderMmpCell({ value: 300, stravaId: '123456' }, newSyncIds));
    const badge = el.querySelector('.mmp-cell__new');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('NEW');
    expect(badge.getAttribute('data-tooltip')).toBe('Set by a ride added in the most recent sync');
  });

  it('does not badge activities absent from newSyncIds', () => {
    const newSyncIds = new Set(['999']);
    const el = parse(renderMmpCell({ value: 300, stravaId: '123456' }, newSyncIds));
    expect(el.querySelector('.mmp-cell__new')).toBeNull();
  });
});

describe('latestActivityLabel', () => {
  afterEach(() => vi.useRealTimers());

  it('reports no rides for an empty or invalid list', () => {
    expect(latestActivityLabel([])).toBe('no rides');
    expect(latestActivityLabel(null)).toBe('no rides');
    expect(latestActivityLabel([{ startTime: NaN }])).toBe('no rides');
  });

  it('labels a ride earlier today as today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T18:00:00'));
    const startTime = new Date('2026-06-15T07:00:00').getTime();
    expect(latestActivityLabel([{ startTime }])).toBe('last ride today');
  });

  it('labels the prior calendar day as yesterday, even under 24h ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T06:00:00'));
    const startTime = new Date('2026-06-14T20:00:00').getTime(); // 10h earlier, but prior calendar day
    expect(latestActivityLabel([{ startTime }])).toBe('last ride yesterday');
  });

  it('counts days for rides within the last week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    const startTime = new Date('2026-06-12T12:00:00').getTime();
    expect(latestActivityLabel([{ startTime }])).toBe('last ride 3 days ago');
  });

  it('falls back to a month/day date beyond a week, same year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    const startTime = new Date('2026-05-01T12:00:00').getTime();
    const expected = new Date(startTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(latestActivityLabel([{ startTime }])).toBe(`last ride ${expected}`);
  });

  it('includes the year when the ride is from a prior year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    const startTime = new Date('2025-01-10T12:00:00').getTime();
    const expected = new Date(startTime).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    expect(latestActivityLabel([{ startTime }])).toBe(`last ride ${expected}`);
  });

  it('picks the most recent of multiple activities', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    const older = new Date('2026-06-01T12:00:00').getTime();
    const newer = new Date('2026-06-14T12:00:00').getTime();
    expect(latestActivityLabel([{ startTime: older }, { startTime: newer }])).toBe('last ride yesterday');
  });

  it('still says "N days ago" just under the 7-day cutoff', () => {
    const now = new Date('2026-06-15T12:00:00');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const startTime = now.getTime() - 6 * 86_400_000;
    expect(latestActivityLabel([{ startTime }])).toBe('last ride 6 days ago');
  });

  it('switches to a formatted date at exactly the 7-day cutoff', () => {
    const now = new Date('2026-06-15T12:00:00');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const startTime = now.getTime() - 7 * 86_400_000;
    const expected = new Date(startTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(latestActivityLabel([{ startTime }])).toBe(`last ride ${expected}`);
  });
});

describe('allTimeLabel', () => {
  afterEach(() => vi.useRealTimers());

  it('reports All-time for an empty or invalid list', () => {
    expect(allTimeLabel([])).toBe('All-time');
    expect(allTimeLabel(null)).toBe('All-time');
  });

  it('labels a recent earliest activity with a Since date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    const startTime = new Date('2026-01-10T12:00:00').getTime();
    const expected = new Date(startTime).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    expect(allTimeLabel([{ startTime }])).toBe(`Since ${expected}`);
  });

  it('falls back to All-time once the earliest activity is 3+ years old', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    const startTime = new Date('2023-01-01T12:00:00').getTime();
    expect(allTimeLabel([{ startTime }])).toBe('All-time');
  });

  it('picks the earliest of multiple activities', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    const earlier = new Date('2026-01-01T12:00:00').getTime();
    const later = new Date('2026-03-01T12:00:00').getTime();
    const expected = new Date(earlier).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    expect(allTimeLabel([{ startTime: earlier }, { startTime: later }])).toBe(`Since ${expected}`);
  });

  it('still says "Since ..." at exactly the 3-year cutoff', () => {
    const now = new Date('2026-06-15T12:00:00');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const startTime = now.getTime() - 365 * 3 * 86_400_000;
    const expected = new Date(startTime).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    expect(allTimeLabel([{ startTime }])).toBe(`Since ${expected}`);
  });

  it('falls back to All-time just past the 3-year cutoff', () => {
    const now = new Date('2026-06-15T12:00:00');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const startTime = now.getTime() - (365 * 3 * 86_400_000 + 1);
    expect(allTimeLabel([{ startTime }])).toBe('All-time');
  });
});

describe('rmseQuality', () => {
  it('bands watts into excellent/good/noisy/poor fit', () => {
    expect(rmseQuality(4.9)).toEqual({ label: 'excellent', cls: 'is-good' });
    expect(rmseQuality(5)).toEqual({ label: 'good', cls: 'is-good' });
    expect(rmseQuality(14.9)).toEqual({ label: 'good', cls: 'is-good' });
    expect(rmseQuality(15)).toEqual({ label: 'noisy', cls: 'is-mid' });
    expect(rmseQuality(29.9)).toEqual({ label: 'noisy', cls: 'is-mid' });
    expect(rmseQuality(30)).toEqual({ label: 'poor fit', cls: 'is-bad' });
  });
});

describe('pointsQuality', () => {
  it('bands point counts into full/ok/minimal/too few', () => {
    expect(pointsQuality(9)).toEqual({ label: 'full', cls: 'is-good' });
    expect(pointsQuality(7)).toEqual({ label: 'full', cls: 'is-good' });
    expect(pointsQuality(6)).toEqual({ label: 'ok', cls: 'is-mid' });
    expect(pointsQuality(4)).toEqual({ label: 'ok', cls: 'is-mid' });
    expect(pointsQuality(3)).toEqual({ label: 'minimal', cls: 'is-bad' });
    expect(pointsQuality(2)).toEqual({ label: 'minimal', cls: 'is-bad' });
    expect(pointsQuality(1)).toEqual({ label: 'too few', cls: 'is-bad' });
    expect(pointsQuality(0)).toEqual({ label: 'too few', cls: 'is-bad' });
  });
});

describe('cpQuality', () => {
  it('flags override and fallback fits before treating anything else as data-driven', () => {
    expect(cpQuality({ overridden: true, fallback: true })).toEqual({ label: 'override', cls: 'is-mid' });
    expect(cpQuality({ fallback: true })).toEqual({ label: 'all-time', cls: 'is-mid' });
    expect(cpQuality({})).toEqual({ label: 'data', cls: 'is-good' });
  });
});

describe('cpTooltip', () => {
  it('explains an override fit', () => {
    expect(cpTooltip({ overridden: true })).toMatch(/manual override/);
  });

  it('explains a fallback fit', () => {
    expect(cpTooltip({ fallback: true })).toMatch(/fell back to all-time data/);
  });

  it('reports the P_max asymptote for a 3-parameter fit', () => {
    expect(cpTooltip({ model: '3p', pMaxW: 812.4 })).toMatch(/P_max ≈ 812 W/);
  });

  it('falls back to a generic explanation for a plain regression', () => {
    expect(cpTooltip({ model: '2p' })).toBe('CP came from a normal regression on the active window (last 90 days or your custom range).');
  });

  it('falls back to the generic explanation for a 3p model missing pMaxW', () => {
    expect(cpTooltip({ model: '3p' })).toBe('CP came from a normal regression on the active window (last 90 days or your custom range).');
  });
});

describe('wPrimeQuality', () => {
  it('flags a history-sourced W\' regardless of magnitude', () => {
    expect(wPrimeQuality({ wPrimeSource: 'history', wPrimeJ: 50000 })).toEqual({ label: 'history', cls: 'is-mid' });
  });

  it('bands regression-sourced W\' by kJ', () => {
    expect(wPrimeQuality({ wPrimeJ: 7999 })).toEqual({ label: 'low', cls: 'is-mid' });
    expect(wPrimeQuality({ wPrimeJ: 8000 })).toEqual({ label: 'typical', cls: 'is-good' });
    expect(wPrimeQuality({ wPrimeJ: 24999 })).toEqual({ label: 'typical', cls: 'is-good' });
    expect(wPrimeQuality({ wPrimeJ: 25000 })).toEqual({ label: 'high', cls: 'is-good' });
    expect(wPrimeQuality({ wPrimeJ: 39999 })).toEqual({ label: 'high', cls: 'is-good' });
    expect(wPrimeQuality({ wPrimeJ: 40000 })).toEqual({ label: 'very high', cls: 'is-mid' });
  });

  it('treats a missing fit or missing wPrimeJ as 0 J', () => {
    expect(wPrimeQuality(null)).toEqual({ label: 'low', cls: 'is-mid' });
    expect(wPrimeQuality({})).toEqual({ label: 'low', cls: 'is-mid' });
  });
});

describe('wPrimeTooltip', () => {
  it('explains a history-sourced W\'', () => {
    expect(wPrimeTooltip({ wPrimeSource: 'history' })).toMatch(/anchored on your longer training history/);
  });

  it('explains a regression-sourced W\'', () => {
    expect(wPrimeTooltip({})).toMatch(/10-25 kJ range/);
  });
});

describe('formatTsb', () => {
  it('rounds and signs positive values', () => {
    expect(formatTsb(4.6)).toBe('+5');
  });

  it('does not sign zero or negative values', () => {
    expect(formatTsb(0)).toBe('0');
    expect(formatTsb(-4.6)).toBe('-5');
  });
});

describe('usesDefaultK', () => {
  it('uses the default when there is no personal fatigue fit', () => {
    expect(usesDefaultK({})).toBe(true);
  });

  it('uses the default when the personal fit was clamped', () => {
    expect(usesDefaultK({ fatigue: { clamped: true, k: 0.5 } })).toBe(true);
  });

  it('uses the personal fit when present and unclamped', () => {
    expect(usesDefaultK({ fatigue: { clamped: false, k: 0.12 } })).toBe(false);
  });
});

describe('fatigueValue', () => {
  it('reports the cycling default k to 2 decimals when falling back', () => {
    expect(fatigueValue({})).toBe('0.15');
  });

  it('reports the personal k to 2 decimals when a fit is used', () => {
    expect(fatigueValue({ fatigue: { clamped: false, k: 0.123 } })).toBe('0.12');
  });
});

describe('fatigueQuality', () => {
  it('labels a default-k readout as default/is-mid', () => {
    expect(fatigueQuality({})).toEqual({ label: 'default', cls: 'is-mid' });
  });

  it('labels a personal fit by its point count', () => {
    expect(fatigueQuality({ fatigue: { clamped: false, nPoints: 5 } })).toEqual({ label: '5 pts', cls: 'is-good' });
  });
});

describe('fatigueTooltip', () => {
  it('explains an implausible fit that got clamped away', () => {
    const tip = fatigueTooltip({ fatigue: { clamped: true, kRaw: 0.31 } });
    expect(tip).toMatch(/outside the/);
    expect(tip).toMatch(/k = 0\.31/);
    expect(tip).toMatch(/Using the cycling default 0\.15/);
  });

  it('explains too few points to fit at all', () => {
    const tip = fatigueTooltip({});
    expect(tip).toMatch(/Need 3\+ MMP points/);
    expect(tip).toMatch(/Using the cycling default 0\.15/);
  });

  it('explains a personal fit in use', () => {
    const tip = fatigueTooltip({ fatigue: { clamped: false, nPoints: 6 } });
    expect(tip).toMatch(/fitted from 6 long-duration MMP points/);
  });
});

describe('combinedFitQuality', () => {
  it('reports the worse of RMSE and points quality, points winning ties', () => {
    expect(combinedFitQuality({ rmse: 2, nPoints: 9 })).toEqual({ label: 'full', cls: 'is-good' });
    expect(combinedFitQuality({ rmse: 2, nPoints: 1 })).toEqual({ label: 'too few', cls: 'is-bad' });
    expect(combinedFitQuality({ rmse: 40, nPoints: 9 })).toEqual({ label: 'poor fit', cls: 'is-bad' });
  });

  it('picks points as the tiebreaker label when both axes tie in rank', () => {
    expect(combinedFitQuality({ rmse: 20, nPoints: 5 })).toEqual({ label: 'ok', cls: 'is-mid' });
    expect(combinedFitQuality({ rmse: 40, nPoints: 1 })).toEqual({ label: 'too few', cls: 'is-bad' });
  });
});

describe('combinedFitTooltip', () => {
  it('summarizes both axes with their labels', () => {
    const tip = combinedFitTooltip({ rmse: 12.34, nPoints: 6 });
    expect(tip).toMatch(/12\.3 W \(good\)/);
    expect(tip).toMatch(/6 points \(ok\)/);
  });
});

describe('eftpWindowLabel', () => {
  afterEach(() => vi.useRealTimers());

  const fmt = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  it('defaults to "last 90d" with no date bounds', () => {
    expect(eftpWindowLabel(null, null)).toBe('last 90d');
    expect(eftpWindowLabel('', '')).toBe('last 90d');
  });

  it('reports a day count for a range ending today or later', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    expect(eftpWindowLabel('2026-05-16', '2026-06-15')).toBe('last 30d');
    expect(eftpWindowLabel('2026-06-01', '2026-06-20')).toBe('last 19d');
  });

  it('formats a fully past range as a from -> to span', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    expect(eftpWindowLabel('2026-01-01', '2026-01-31')).toBe(`${fmt('2026-01-01')} → ${fmt('2026-01-31')}`);
  });

  it('falls back to a from -> to span for a zero-length range even when dateTo is today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    expect(eftpWindowLabel('2026-06-15', '2026-06-15')).toBe(`${fmt('2026-06-15')} → ${fmt('2026-06-15')}`);
  });

  it('reports an open-ended lower bound as "since X"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    expect(eftpWindowLabel('2026-05-01', null)).toBe(`since ${fmt('2026-05-01')}`);
  });

  it('reports an open-ended upper bound as "through X"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
    expect(eftpWindowLabel(null, '2026-05-01')).toBe(`through ${fmt('2026-05-01')}`);
  });
});

describe('eftpTooltip', () => {
  it('describes a 90-day default window when no date range is set', () => {
    expect(eftpTooltip(null, null)).toMatch(/from your most recent 90 days/);
  });

  it('describes a custom window when a date range is set', () => {
    expect(eftpTooltip('2026-01-01', null)).toMatch(/within your selected date range/);
    expect(eftpTooltip(null, '2026-01-01')).toMatch(/within your selected date range/);
  });
});

describe('formQuality', () => {
  it('bands TSB into fresh/stable/building/overloaded', () => {
    expect(formQuality(10)).toEqual({ label: 'fresh', cls: 'is-good' });
    expect(formQuality(5)).toEqual({ label: 'fresh', cls: 'is-good' });
    expect(formQuality(4.9)).toEqual({ label: 'stable', cls: 'is-good' });
    expect(formQuality(-5)).toEqual({ label: 'stable', cls: 'is-good' });
    expect(formQuality(-5.1)).toEqual({ label: 'building', cls: 'is-mid' });
    expect(formQuality(-20)).toEqual({ label: 'building', cls: 'is-mid' });
    expect(formQuality(-20.1)).toEqual({ label: 'overloaded', cls: 'is-bad' });
  });

  it('treats a non-finite TSB as stable', () => {
    expect(formQuality(NaN)).toEqual({ label: 'stable', cls: 'is-good' });
  });
});

describe('formTooltip', () => {
  it('reports rounded CTL/ATL and no adjustment at TSB 0', () => {
    expect(formTooltip(50.4, 45.6, 0)).toBe('Form (TSB) = CTL 50 − ATL 46. Positive = fresh; negative = fatigued. no adjustment. Capped at ±5%.');
  });

  it('reports the uncapped linear adjustment partway to the cap', () => {
    expect(formTooltip(50, 45, 10)).toMatch(/\+2% applied to predictions/);
  });

  it('reports a positive capped adjustment for a TSB past the cap threshold', () => {
    expect(formTooltip(50, 45, 40)).toMatch(/\+5% applied to predictions/);
  });

  it('reports a negative capped adjustment for a TSB past the cap threshold', () => {
    expect(formTooltip(50, 45, -40)).toMatch(/-5% applied to predictions/);
  });
});
