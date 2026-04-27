import { describe, it, expect } from 'vitest';
import { parseDuration } from '../src/duration.js';

describe('parseDuration', () => {
  it('parses minutes', () => {
    expect(parseDuration('45m')).toBe(45 * 60);
    expect(parseDuration('1m')).toBe(60);
  });

  it('parses hours', () => {
    expect(parseDuration('2h')).toBe(2 * 3600);
  });

  it('parses h+m combinations', () => {
    expect(parseDuration('1h30m')).toBe(3600 + 30 * 60);
    expect(parseDuration('2h30m45s')).toBe(2 * 3600 + 30 * 60 + 45);
  });

  it('parses seconds', () => {
    expect(parseDuration('90s')).toBe(90);
  });

  it('is case- and whitespace-tolerant', () => {
    expect(parseDuration(' 1H 30M ')).toBe(3600 + 30 * 60);
    expect(parseDuration('45M')).toBe(45 * 60);
  });

  it('returns null for invalid input', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('45')).toBeNull();
    expect(parseDuration('0m')).toBeNull();
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
  });
});
