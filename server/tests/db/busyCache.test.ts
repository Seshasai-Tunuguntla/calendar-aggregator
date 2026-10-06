import { beforeEach, describe, expect, it } from 'vitest';
import type { Interval } from '@calendar-aggregator/shared/slots';
import { BUSY_CACHE_TTL_MS, cachedBusyIntervals, invalidateBusyCache } from '../../src/calendar/busyCache.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { createUser } from '../helpers/factories.ts';

const db = useTestDatabase();

const NOW = Date.parse('2026-10-12T02:30:00Z');
const HOUR = 60 * 60 * 1000;
const WEEK = { start: NOW, end: NOW + 7 * 24 * HOUR };
const BUSY: Interval[] = [{ start: NOW + HOUR, end: NOW + 2 * HOUR }];

let hostId: string;
let loads: Interval[];
const load = async (window: Interval) => {
  loads.push(window);
  return BUSY;
};
const failing = async (): Promise<Interval[]> => {
  throw new Error('Google is down');
};
const get = (range: Interval, now = NOW, loader = load, host = hostId) => cachedBusyIntervals({ db, hostId: host, range, now, load: loader });

beforeEach(async () => {
  hostId = (await createUser(db)).id;
  loads = [];
});

describe('cachedBusyIntervals', () => {
  it('reads the calendars once, then answers from the cache for 60 seconds', async () => {
    expect(await get(WEEK)).toEqual(BUSY);
    expect(await get(WEEK, NOW + BUSY_CACHE_TTL_MS - 1)).toEqual(BUSY);
    expect(loads).toHaveLength(1);
    await get(WEEK, NOW + BUSY_CACHE_TTL_MS);
    expect(loads).toHaveLength(2);
  });

  it('reads a little more than asked, so a range that has moved slightly later is still served', async () => {
    await get(WEEK);
    expect(loads[0]).toEqual({ start: WEEK.start, end: WEEK.end + HOUR });
    await get({ start: WEEK.start + 30_000, end: WEEK.end + 30_000 }, NOW + 30_000);
    expect(loads).toHaveLength(1);
    // Earlier than what was read, or beyond the slack: read again.
    await get({ start: WEEK.start - 1, end: WEEK.end });
    await get({ start: WEEK.start, end: WEEK.end + HOUR + 1 });
    expect(loads).toHaveLength(3);
  });

  it('makes requests that arrive together share one read', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => get(WEEK)));
    expect(results).toEqual(Array.from({ length: 5 }, () => BUSY));
    expect(loads).toHaveLength(1);
    expect(await db.busyCache.count()).toBe(1);
  });

  it("doesn't cache failures: the next request reads again", async () => {
    await expect(get(WEEK, NOW, failing)).rejects.toThrow('Google is down');
    expect(await get(WEEK)).toEqual(BUSY);
    expect(loads).toHaveLength(1);
  });

  it('starts over after invalidation, even if a read was in progress', async () => {
    await get(WEEK);
    await invalidateBusyCache(db, hostId);
    await get(WEEK);
    expect(loads).toHaveLength(2);

    // A read that was running when the cache was cleared may predate the change: not stored.
    await invalidateBusyCache(db, hostId);
    let release: ((busy: Interval[]) => void) | undefined;
    const slow = (window: Interval) =>
      new Promise<Interval[]>((resolve) => {
        loads.push(window);
        release = resolve;
      });
    const pending = get(WEEK, NOW, slow);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await invalidateBusyCache(db, hostId);
    release?.(BUSY);
    await pending;
    expect(await db.busyCache.count({ where: { hostId } })).toBe(0);
  });

  it("keeps hosts apart, and deletes every host's expired rows as new ones are stored", async () => {
    const otherHost = (await createUser(db)).id;
    await get(WEEK, NOW, load, otherHost);
    await get(WEEK);
    expect(loads).toHaveLength(2);
    expect(await db.busyCache.count()).toBe(2);

    await get(WEEK, NOW + BUSY_CACHE_TTL_MS);
    expect(await db.busyCache.findMany({ select: { hostId: true, fetchedAt: true } })).toEqual([{ hostId, fetchedAt: new Date(NOW + BUSY_CACHE_TTL_MS) }]);
  });

  it('is deleted with the host', async () => {
    await get(WEEK);
    await db.user.delete({ where: { id: hostId } });
    expect(await db.busyCache.count()).toBe(0);
  });
});
