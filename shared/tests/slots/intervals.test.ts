import { describe, expect, it } from 'vitest';
import { isCovered, mergeIntervals, subtractIntervals, type Interval } from '../../src/slots/index.ts';

// Small numbers stand in for timestamps: the functions only compare them.
const i = (start: number, end: number): Interval => ({ start, end });

describe('mergeIntervals', () => {
  it('merges overlapping intervals', () => {
    expect(mergeIntervals([i(1, 5), i(3, 8)])).toEqual([i(1, 8)]);
  });

  it('merges touching intervals: [1, 3) and [3, 5) leave no gap', () => {
    expect(mergeIntervals([i(1, 3), i(3, 5)])).toEqual([i(1, 5)]);
  });

  it('keeps intervals with a gap between them apart', () => {
    expect(mergeIntervals([i(1, 3), i(4, 5)])).toEqual([i(1, 3), i(4, 5)]);
  });

  it('absorbs an interval contained in another', () => {
    expect(mergeIntervals([i(1, 10), i(2, 3), i(4, 12)])).toEqual([i(1, 12)]);
  });

  it('sorts unsorted input first', () => {
    expect(mergeIntervals([i(7, 9), i(1, 2), i(2, 4), i(8, 10)])).toEqual([i(1, 4), i(7, 10)]);
  });

  it('drops empty intervals and handles an empty list', () => {
    expect(mergeIntervals([i(5, 5), i(6, 4)])).toEqual([]);
    expect(mergeIntervals([])).toEqual([]);
  });

  it('does not change its input', () => {
    const input = [i(3, 6), i(1, 4)];
    mergeIntervals(input);
    expect(input).toEqual([i(3, 6), i(1, 4)]);
  });
});

describe('subtractIntervals', () => {
  it('returns the base unchanged when nothing is cut', () => {
    expect(subtractIntervals([i(0, 10)], [])).toEqual([i(0, 10)]);
  });

  it('splits an interval around a cut in the middle', () => {
    expect(subtractIntervals([i(0, 10)], [i(3, 5)])).toEqual([i(0, 3), i(5, 10)]);
  });

  it('trims cuts that overlap either edge', () => {
    expect(subtractIntervals([i(0, 10)], [i(-5, 2), i(8, 15)])).toEqual([i(2, 8)]);
  });

  it('leaves nothing when a cut covers the whole interval', () => {
    expect(subtractIntervals([i(2, 8)], [i(0, 10)])).toEqual([]);
  });

  it('applies one cut to every base interval it spans', () => {
    expect(subtractIntervals([i(0, 4), i(6, 10), i(12, 14)], [i(3, 7)])).toEqual([i(0, 3), i(7, 10), i(12, 14)]);
  });

  it('applies many cuts to one base interval', () => {
    expect(subtractIntervals([i(0, 20)], [i(1, 2), i(5, 6), i(10, 19)])).toEqual([i(0, 1), i(2, 5), i(6, 10), i(19, 20)]);
  });

  it('ignores cuts that only touch the edges', () => {
    expect(subtractIntervals([i(5, 10)], [i(0, 5), i(10, 12)])).toEqual([i(5, 10)]);
  });
});

describe('isCovered', () => {
  const free = [i(0, 10), i(20, 30)];

  it('is true inside one interval, including exactly matching it', () => {
    expect(isCovered(free, 2, 8)).toBe(true);
    expect(isCovered(free, 20, 30)).toBe(true);
  });

  it('is false when the range runs past the end of an interval', () => {
    expect(isCovered(free, 5, 11)).toBe(false);
  });

  it('is false across a gap, even though both ends are inside intervals', () => {
    expect(isCovered(free, 5, 25)).toBe(false);
  });

  it('is false before the first interval, in a gap, and for an empty list', () => {
    expect(isCovered(free, -5, -1)).toBe(false);
    expect(isCovered(free, 12, 15)).toBe(false);
    expect(isCovered([], 0, 1)).toBe(false);
  });
});
