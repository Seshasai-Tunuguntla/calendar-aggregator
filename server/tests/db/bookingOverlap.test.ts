import { describe, expect, it } from 'vitest';
import { isOverlappingBooking } from '../../src/bookings/bookings.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { createBooking, createEventType, createUser } from '../helpers/factories.ts';

const db = useTestDatabase();

// The last line of defence against double booking: if anything ever inserted an overlapping
// confirmed booking past the host's lock, Postgres refuses it and the app must recognise that.
describe('isOverlappingBooking', () => {
  it("recognises Postgres refusing an overlapping booking, and nothing else", async () => {
    const host = await createUser(db);
    const eventType = await createEventType(db, host.id);
    const at = { eventTypeId: eventType.id, hostId: host.id };
    await createBooking(db, { ...at, start: '2026-10-12T03:30Z', end: '2026-10-12T04:00Z' });

    const overlap = await createBooking(db, { ...at, start: '2026-10-12T03:45Z', end: '2026-10-12T04:15Z' }).catch((e: unknown) => e);
    expect(isOverlappingBooking(overlap)).toBe(true);

    const otherFailure = await createBooking(db, { ...at, start: '2026-10-12T05:00Z', end: '2026-10-12T04:00Z' }).catch((e: unknown) => e);
    expect(otherFailure).toBeInstanceOf(Error);
    expect(isOverlappingBooking(otherFailure)).toBe(false);
    expect(isOverlappingBooking(new Error('23P01 Booking_no_overlapping_confirmed'))).toBe(false);
  });
});
