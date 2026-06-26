import { describe, it, expect } from 'vitest';
import { activitiesToRefresh } from '../src/sync-merge.js';

describe('activitiesToRefresh', () => {
  it('includes activities not present in the cache', () => {
    const remote = [{ startTime: 100, mmpVersion: 2 }];
    expect(activitiesToRefresh(remote, [])).toEqual([{ startTime: 100, mmpVersion: 2 }]);
  });

  it('includes cached activities whose mmpVersion changed', () => {
    const remote = [{ startTime: 100, mmpVersion: 2 }];
    const cached = [{ startTime: 100, mmpVersion: 1 }];
    expect(activitiesToRefresh(remote, cached)).toEqual([{ startTime: 100, mmpVersion: 2 }]);
  });

  it('excludes cached activities already at the same mmpVersion', () => {
    const remote = [{ startTime: 100, mmpVersion: 2 }];
    const cached = [{ startTime: 100, mmpVersion: 2 }];
    expect(activitiesToRefresh(remote, cached)).toEqual([]);
  });

  it('treats a missing cached version as different from a stamped remote', () => {
    const remote = [{ startTime: 100, mmpVersion: 2 }];
    const cached = [{ startTime: 100 }]; // legacy record, no mmpVersion
    expect(activitiesToRefresh(remote, cached)).toEqual([{ startTime: 100, mmpVersion: 2 }]);
  });
});
