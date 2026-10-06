import { describe, expect, it } from 'vitest';
import { computeSlots, type SlotRequest } from '../../src/slots/index.ts';
import { randomRequest, referenceSlots, seededRandom } from './reference.ts';
import { IST, MONDAY, local, slotRequest, utcOffset } from './helpers.ts';

const SEEDS = 400;

describe('computeSlots against the slow reference implementation', () => {
  it('agrees on the plain request used by the other tests', () => {
    const request = slotRequest({ busy: [local(IST, MONDAY, '10:00', '11:00')], bufferAfterMinutes: 15 });
    expect(computeSlots(request)).toEqual(referenceSlots(request));
  });

  it(`agrees on ${SEEDS} random requests (zones, DST weeks, overlapping rules and busy time)`, () => {
    const stats = { slots: 0, empty: 0, buffersMattered: 0, maxPerDayMattered: 0, acrossDstWithSlots: 0 };

    for (let seed = 1; seed <= SEEDS; seed++) {
      const request = randomRequest(seededRandom(seed));
      const fast = computeSlots(request);
      // The seed in the message makes any failure reproducible on its own.
      expect(fast, `seed ${seed}: ${JSON.stringify(request)}`).toEqual(referenceSlots(request));

      stats.slots += fast.length;
      if (fast.length === 0) stats.empty++;
      if (differs(request, fast, { bufferBeforeMinutes: 0, bufferAfterMinutes: 0 })) stats.buffersMattered++;
      if (differs(request, fast, { maxPerDay: null })) stats.maxPerDayMattered++;
      const { range, hostTimeZone } = request;
      if (fast.length > 0 && utcOffset(range.start, hostTimeZone) !== utcOffset(range.end, hostTimeZone)) {
        stats.acrossDstWithSlots++;
      }
    }

    // Guard against the comparison passing vacuously: the random requests must actually produce
    // slots, sometimes none, cross real DST changes, and exercise buffers and the daily limit.
    expect(stats.slots).toBeGreaterThan(SEEDS * 20);
    expect(stats.empty).toBeGreaterThan(10);
    expect(stats.empty).toBeLessThan(SEEDS / 3);
    expect(stats.acrossDstWithSlots).toBeGreaterThan(40);
    expect(stats.buffersMattered).toBeGreaterThan(20);
    expect(stats.maxPerDayMattered).toBeGreaterThan(10);
  });
});

function differs(request: SlotRequest, slots: unknown, change: Partial<SlotRequest>): boolean {
  return JSON.stringify(computeSlots({ ...request, ...change })) !== JSON.stringify(slots);
}

