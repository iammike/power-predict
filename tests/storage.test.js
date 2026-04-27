import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  loadActivities,
  saveActivities,
  hasActivity,
  clearActivities,
  activityCount,
} from '../src/storage.js';

describe('storage', () => {
  beforeEach(async () => {
    await clearActivities();
  });

  it('save + load round-trip', async () => {
    await saveActivities([
      { startTime: 1000, durationS: 60, mmp: { 60: 250 } },
      { startTime: 2000, durationS: 120, mmp: { 60: 300 } },
    ]);
    const all = await loadActivities();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.startTime).sort()).toEqual([1000, 2000]);
  });

  it('hasActivity reflects existence', async () => {
    await saveActivities([{ startTime: 42, durationS: 10, mmp: {} }]);
    expect(await hasActivity(42)).toBe(true);
    expect(await hasActivity(99)).toBe(false);
  });

  it('put with same startTime overwrites', async () => {
    await saveActivities([{ startTime: 5, durationS: 10, mmp: { 60: 100 } }]);
    await saveActivities([{ startTime: 5, durationS: 10, mmp: { 60: 200 } }]);
    const all = await loadActivities();
    expect(all).toHaveLength(1);
    expect(all[0].mmp[60]).toBe(200);
  });

  it('clearActivities empties the store', async () => {
    await saveActivities([{ startTime: 1, durationS: 1, mmp: {} }]);
    await clearActivities();
    expect(await activityCount()).toBe(0);
  });
});
