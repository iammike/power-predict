import { describe, it, expect } from 'vitest';
import { buildIdMap, parseCsv } from '../src/archive-worker.js';

const enc = (s) => new TextEncoder().encode(s);

describe('parseCsv', () => {
  it('parses a simple csv', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('handles quoted fields with commas', () => {
    expect(parseCsv('a,b\n"hello, world",2\n')).toEqual([
      ['a', 'b'],
      ['hello, world', '2'],
    ]);
  });

  it('handles escaped double quotes', () => {
    expect(parseCsv('a\n"she said ""hi"""\n')).toEqual([['a'], ['she said "hi"']]);
  });

  it('handles CRLF endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('buildIdMap', () => {
  it('maps full path and basename to activity ID', () => {
    const csv = enc(
      'Activity ID,Activity Date,Filename\n' +
      '12345,"Jan 1, 2024",activities/9876.fit.gz\n'
    );
    const m = buildIdMap(csv);
    expect(m.get('activities/9876.fit.gz')).toBe('12345');
    expect(m.get('9876.fit.gz')).toBe('12345');
  });

  it('resolves columns by header name (order-independent)', () => {
    const csv = enc(
      'Filename,Activity Name,Activity ID\n' +
      'activities/A.fit.gz,Morning ride,99\n'
    );
    expect(buildIdMap(csv).get('activities/A.fit.gz')).toBe('99');
  });

  it('returns null when required headers are missing', () => {
    const csv = enc('Activity ID,Foo\n1,bar\n');
    expect(buildIdMap(csv)).toBeNull();
  });

  it('skips rows missing an ID or filename', () => {
    const csv = enc(
      'Activity ID,Filename\n' +
      ',activities/skipped.fit.gz\n' +
      '42,\n' +
      '7,activities/X.fit\n'
    );
    const m = buildIdMap(csv);
    expect(m.size).toBe(2); // 7 → "activities/X.fit" + "X.fit"
    expect(m.get('activities/X.fit')).toBe('7');
  });
});
