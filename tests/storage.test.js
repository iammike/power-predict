import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  loadActivities,
  saveActivities,
  hasActivity,
  clearActivities,
  removeActivitiesByStravaId,
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

  it('removeActivitiesByStravaId prunes only the matching rows', async () => {
    await saveActivities([
      { startTime: 1000, stravaId: '1', durationS: 60, mmp: {} },
      { startTime: 2000, stravaId: '2', durationS: 60, mmp: {} }, // the run
      { startTime: 3000, stravaId: '3', durationS: 60, mmp: {} },
      { startTime: 4000, durationS: 60, mmp: {} },                // archive upload, no stravaId
    ]);
    const removed = await removeActivitiesByStravaId(['2']);
    expect(removed).toBe(1);
    const left = (await loadActivities()).map((a) => a.startTime).sort((x, y) => x - y);
    expect(left).toEqual([1000, 3000, 4000]);
  });

  it('removeActivitiesByStravaId matches numeric and string ids and no-ops on empty', async () => {
    await saveActivities([{ startTime: 1000, stravaId: 12345, durationS: 60, mmp: {} }]);
    expect(await removeActivitiesByStravaId([])).toBe(0);
    expect(await removeActivitiesByStravaId(['12345'])).toBe(1);
    expect(await activityCount()).toBe(0);
  });
});
