import { describe, it, expect } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshTokens,
  generateRandomToken,
} from '../worker/strava-oauth.js';

describe('buildAuthorizeUrl', () => {
  it('encodes all required params', () => {
    const url = new URL(buildAuthorizeUrl({
      clientId: '12345',
      redirectUri: 'https://api.example.com/auth/strava/callback',
      state: 'abc',
      scope: 'read,activity:read_all',
    }));
    expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('12345');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.com/auth/strava/callback');
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('scope')).toBe('read,activity:read_all');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('exchangeCodeForTokens', () => {
  it('POSTs the code to Strava and returns the parsed JSON', async () => {
    let capturedUrl, capturedInit;
    const fakeFetch = async (u, init) => {
      capturedUrl = u;
      capturedInit = init;
      return new Response(JSON.stringify({
        access_token: 'a', refresh_token: 'r', expires_at: 9999, athlete: { id: 7 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const out = await exchangeCodeForTokens({
      clientId: 'cid', clientSecret: 'sec', code: 'CODE',
    }, fakeFetch);
    expect(capturedUrl).toBe('https://www.strava.com/oauth/token');
    expect(capturedInit.method).toBe('POST');
    const params = new URLSearchParams(capturedInit.body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('CODE');
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('client_secret')).toBe('sec');
    expect(out.access_token).toBe('a');
    expect(out.athlete.id).toBe(7);
  });

  it('throws when credentials are missing', async () => {
    await expect(exchangeCodeForTokens({ code: 'x' }, async () => new Response('')))
      .rejects.toThrow(/credentials missing/);
  });

  it('throws on non-2xx', async () => {
    const fakeFetch = async () => new Response('bad request', { status: 400 });
    await expect(exchangeCodeForTokens({
      clientId: 'c', clientSecret: 's', code: 'x',
    }, fakeFetch)).rejects.toThrow(/token exchange failed: 400/);
  });
});

describe('refreshTokens', () => {
  it('uses grant_type=refresh_token', async () => {
    let captured;
    const fakeFetch = async (_u, init) => {
      captured = init;
      return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'next', expires_at: 1 }), { status: 200 });
    };
    const out = await refreshTokens({
      clientId: 'c', clientSecret: 's', refreshToken: 'r',
    }, fakeFetch);
    const params = new URLSearchParams(captured.body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('r');
    expect(out.access_token).toBe('new');
  });
});

describe('generateRandomToken', () => {
  it('returns a base64url string of expected length', () => {
    const t = generateRandomToken(32);
    // 32 bytes → 43 base64url chars (no padding)
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBe(43);
  });
  it('produces distinct tokens across calls', () => {
    const a = generateRandomToken();
    const b = generateRandomToken();
    expect(a).not.toBe(b);
  });
});
