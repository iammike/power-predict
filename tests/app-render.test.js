import { describe, it, expect, vi, afterEach } from 'vitest';
// app.js fires hydrateFromCache() at module scope (side effect of import,
// not of anything in this file) -- without a real IDB it fails safely into
// a caught rejection, but this keeps that path quiet.
import 'fake-indexeddb/auto';
import { formatBytes, renderMmpCell, latestActivityLabel, allTimeLabel } from '../src/app.js';

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
