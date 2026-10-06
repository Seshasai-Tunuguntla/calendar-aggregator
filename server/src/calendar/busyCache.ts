import { z } from 'zod';
import { HOUR_MS, type Interval } from '@calendar-aggregator/shared/slots';
import type { Db } from '../db.ts';

// How long a host's busy intervals are reused. Long enough that a page full of guests causes one
// read of the host's calendars; short enough that a change on Google shows up within a minute.
// Bookings made here never wait for it: slots always read our own bookings fresh, and making one
// clears the cache.
export const BUSY_CACHE_TTL_MS = 60 * 1000;

// Each read covers a little more than asked: the requested span shifts later as time passes (the
// minimum-notice edge moves with "now"), and a longer event type on the same page needs a slightly
// longer one. An hour of slack lets those requests reuse the same row.
const WINDOW_SLACK_MS = HOUR_MS;

const intervalsSchema = z.array(z.tuple([z.number(), z.number()]));

// Reads in progress on this server instance, so requests that arrive while one is running join it
// instead of reading the calendars again. (Across instances, the table is what's shared.)
const inFlight = new Map<string, { window: Interval; promise: Promise<Interval[]> }[]>();

// Per host, the decision "join a read in progress, use the table, or start a read" is taken one
// request at a time. Otherwise guests arriving together would all look in the table before any of
// them had registered a read, and every one would read the calendars.
const decisions = new Map<string, Promise<void>>();

function oneAtATime<T>(hostId: string, task: () => Promise<T>): Promise<T> {
  const previous = decisions.get(hostId) ?? Promise.resolve();
  const result = previous.then(task);
  const done = result.then(
    () => undefined,
    () => undefined,
  );
  decisions.set(hostId, done);
  void done.then(() => {
    if (decisions.get(hostId) === done) decisions.delete(hostId);
  });
  return result;
}

const covers = (window: Interval, range: Interval) => window.start <= range.start && window.end >= range.end;

interface Request {
  db: Db;
  hostId: string;
  range: Interval;
  now: number;
  load: (window: Interval) => Promise<Interval[]>;
}

// The host's busy intervals for (at least) `range`, from a fresh cached read that covers it, or
// else from `load` (which reads the calendars). Intervals outside `range` may come back too; the
// slot algorithm ignores them. Failures are not cached: the next request tries again, and slots
// still fail closed.
export async function cachedBusyIntervals(request: Request): Promise<Interval[]> {
  // Wrapped in an object so the queue only waits for the decision, not for the read itself.
  const { promise } = await oneAtATime(request.hostId, () => findOrStartRead(request));
  return promise;
}

async function findOrStartRead({ db, hostId, range, now, load }: Request): Promise<{ promise: Promise<Interval[]> }> {
  const joining = inFlight.get(hostId)?.find((entry) => covers(entry.window, range));
  if (joining) return { promise: joining.promise };

  const cached = await db.busyCache.findFirst({
    where: {
      hostId,
      fetchedAt: { gt: new Date(now - BUSY_CACHE_TTL_MS) },
      windowStart: { lte: new Date(range.start) },
      windowEnd: { gte: new Date(range.end) },
    },
    orderBy: { fetchedAt: 'desc' },
    select: { intervals: true },
  });
  if (cached) return { promise: Promise.resolve(intervalsSchema.parse(cached.intervals).map(([start, end]) => ({ start, end }))) };

  const window = { start: range.start, end: range.end + WINDOW_SLACK_MS };
  const entry = { window, promise: Promise.resolve([] as Interval[]) };
  entry.promise = (async () => {
    try {
      const intervals = await load(window);
      // Not stored if the cache was cleared while reading: the result may predate the change.
      if (inFlight.get(hostId)?.includes(entry)) {
        await db.$transaction([
          // Expired rows of every host go as new ones arrive (no background timer on serverless).
          db.busyCache.deleteMany({ where: { fetchedAt: { lte: new Date(now - BUSY_CACHE_TTL_MS) } } }),
          db.busyCache.create({
            data: { hostId, windowStart: new Date(window.start), windowEnd: new Date(window.end), fetchedAt: new Date(now), intervals: intervals.map((i) => [i.start, i.end]) },
          }),
        ]);
      }
      return intervals;
    } finally {
      const remaining = (inFlight.get(hostId) ?? []).filter((e) => e !== entry);
      if (remaining.length > 0) inFlight.set(hostId, remaining);
      else inFlight.delete(hostId);
    }
  })();
  inFlight.set(hostId, [...(inFlight.get(hostId) ?? []), entry]);
  return { promise: entry.promise };
}

// Call whenever what a host's busy time depends on changes: a booking made or cancelled, a
// calendar ticked or unticked, calendars synced, an account disconnected.
export async function invalidateBusyCache(db: Db, hostId: string): Promise<void> {
  inFlight.delete(hostId);
  await db.busyCache.deleteMany({ where: { hostId } });
}
