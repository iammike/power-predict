import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseAuthHash, authorizeUrl, API_BASE,
  loadSession, saveSession, clearSession,
  syncRecent, fetchSyncedActivities, UnauthenticatedError, StravaUnavailableError,
} from '../src/strava-session.js';
import { saveSettings } from '../src/storage.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('parseAuthHash', () => {
  it('returns null for empty / missing hash', () => {
    expect(parseAuthHash('')).toBeNull();
    expect(parseAuthHash('#')).toBeNull();
    expect(parseAuthHash(undefined)).toBeNull();
  });

  it('parses session + athlete_id from a fragment', () => {
    const out = parseAuthHash('#session=abc&athlete_id=123');
    expect(out).toEqual({ session: 'abc', athleteId: '123', error: null });
  });

  it('accepts a fragment without leading #', () => {
    const out = parseAuthHash('session=abc&athlete_id=42');
    expect(out.session).toBe('abc');
    expect(out.athleteId).toBe('42');
  });

  it('captures error params', () => {
    const out = parseAuthHash('#error=token_exchange_failed');
    expect(out).toEqual({ session: null, athleteId: null, error: 'token_exchange_failed' });
  });

  it('returns null when none of the expected params are present', () => {
    expect(parseAuthHash('#some=other')).toBeNull();
  });
});

describe('authorizeUrl', () => {
  it('points at the worker with the return_to query param', () => {
    const url = new URL(authorizeUrl('/?after=sync'));
    expect(url.origin).toBe(API_BASE);
    expect(url.pathname).toBe('/auth/strava/authorize');
    expect(url.searchParams.get('return_to')).toBe('/?after=sync');
  });
  it('defaults to / when no return path is given', () => {
    const url = new URL(authorizeUrl());
    expect(url.searchParams.get('return_to')).toBe('/');
  });
});

describe('session persistence', () => {
  beforeEach(async () => {
    // Clear the IDB row between tests so each starts fresh.
    await saveSettings({});
  });

  it('round-trips through IDB', async () => {
    expect(await loadSession()).toBeNull();
    await saveSession({ session: 'tok', athleteId: '99' });
    expect(await loadSession()).toEqual({ session: 'tok', athleteId: '99' });
  });

  it('clearSession removes the keys but leaves other settings intact', async () => {
    await saveSettings({ cpOverrideW: 280 });
    await saveSession({ session: 'tok', athleteId: '99' });
    await clearSession();
    expect(await loadSession()).toBeNull();
    // unrelated setting still there
    const { loadSettings: load } = await import('../src/storage.js');
    const s = await load();
    expect(s.cpOverrideW).toBe(280);
  });
});

describe('401 handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('syncRecent throws UnauthenticatedError on a 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthenticated' })));
    await expect(syncRecent({ session: 'dead' })).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('syncRecent throws StravaUnavailableError on a 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'strava list activities 500' })));
    const err = await syncRecent({ session: 'tok' }).catch((e) => e);
    expect(err).toBeInstanceOf(StravaUnavailableError);
    expect(err.stravaUnavailable).toBe(true);
    expect(err.unauthenticated).toBeUndefined();
  });

  it('fetchSyncedActivities throws StravaUnavailableError on a 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, { error: 'unavailable' })));
    await expect(fetchSyncedActivities('tok')).rejects.toBeInstanceOf(StravaUnavailableError);
  });

  it('syncRecent throws a plain Error on a 4xx that is not 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'bad json' })));
    const err = await syncRecent({ session: 'tok' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.unauthenticated).toBeUndefined();
    expect(err.stravaUnavailable).toBeUndefined();
  });

  it('fetchSyncedActivities throws UnauthenticatedError on a 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthenticated' })));
    await expect(fetchSyncedActivities('dead')).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('a thrown UnauthenticatedError carries the unauthenticated flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthenticated' })));
    const err = await fetchSyncedActivities('dead').catch((e) => e);
    expect(err.unauthenticated).toBe(true);
  });
});
