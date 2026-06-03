import { describe, it, expect } from 'vitest';
import { normalizeType, isRideType, isRideActivity } from '../src/sport.js';

describe('isRideType', () => {
  it('accepts cycling types in both API camelCase and CSV spaced forms', () => {
    for (const t of [
      'Ride', 'VirtualRide', 'GravelRide', 'MountainBikeRide',
      'Virtual Ride', 'Gravel Ride', 'Mountain Bike Ride',
    ]) {
      expect(isRideType(t)).toBe(true);
    }
  });

  it('rejects runs, walks, and other non-cycling types', () => {
    for (const t of ['Run', 'TrailRun', 'Virtual Run', 'Walk', 'Hike', 'Swim', 'Workout', '']) {
      expect(isRideType(t)).toBe(false);
    }
  });

  it('excludes e-bikes (motor-assisted)', () => {
    for (const t of ['EBikeRide', 'E-Bike Ride', 'EMountainBikeRide', 'E-Mountain Bike Ride']) {
      expect(isRideType(t)).toBe(false);
    }
  });

  it('handles null / undefined / non-string input', () => {
    expect(isRideType(null)).toBe(false);
    expect(isRideType(undefined)).toBe(false);
    expect(isRideType(123)).toBe(false);
  });
});

describe('normalizeType', () => {
  it('lowercases and strips non-letters', () => {
    expect(normalizeType('Mountain Bike Ride')).toBe('mountainbikeride');
    expect(normalizeType('E-Bike Ride')).toBe('ebikeride');
  });
});

describe('isRideActivity', () => {
  it('prefers sport_type over the legacy type', () => {
    expect(isRideActivity({ sport_type: 'Run', type: 'Ride' })).toBe(false);
    expect(isRideActivity({ sport_type: 'VirtualRide', type: 'Workout' })).toBe(true);
  });

  it('falls back to type when sport_type is absent', () => {
    expect(isRideActivity({ type: 'Ride' })).toBe(true);
    expect(isRideActivity({ type: 'Run' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRideActivity(null)).toBe(false);
  });
});
