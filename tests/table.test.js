import { describe, it, expect } from 'vitest';
import { partitionDurations, TABLE_SPLIT_S } from '../src/table.js';

describe('partitionDurations', () => {
  it('splits at 1h by default, with 1h in the visible set', () => {
    const { short, long } = partitionDurations([60, 1200, 3600, 7200, 14400]);
    expect(short).toEqual([60, 1200, 3600]);
    expect(long).toEqual([7200, 14400]);
  });

  it('leaves the long tail empty when no data passes the split', () => {
    expect(partitionDurations([60, 1200, 3600]).long).toEqual([]);
  });

  it('exposes the split constant', () => {
    expect(TABLE_SPLIT_S).toBe(3600);
  });
});
