import { z } from 'zod';
import { timeZoneSchema } from '../time/timeZone.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_SLOT_QUERY_DAYS = 42;

// GET /api/public/book/:handle/:slug: what a guest sees about the host and the event type. No
// email, calendar names, settings or anything else private.
export const publicEventTypeResponseSchema = z.object({
  // isDemo: the public demo host, whose bookings send no invitation (the confirmation says so).
  host: z.object({ name: z.string(), timeZone: z.string(), isDemo: z.boolean() }),
  eventType: z.object({ slug: z.string(), title: z.string(), description: z.string(), durationMinutes: z.int() }),
});
export type PublicEventTypeResponse = z.infer<typeof publicEventTypeResponseSchema>;

// GET /api/public/book/:handle/:slug/slots?from=2026-10-12&to=2026-10-19&tz=America/New_York
// from and to are dates in the guest's time zone (to is exclusive), so the server, which has a
// time-zone library, works out where the guest's days start; the client only formats.
export const slotsQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date(), tz: timeZoneSchema })
  .refine((q) => q.to > q.from, { message: '"to" must be after "from"', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / DAY_MS <= MAX_SLOT_QUERY_DAYS, {
    message: `At most ${MAX_SLOT_QUERY_DAYS} days at a time`,
    path: ['to'],
  });
export type SlotsQuery = z.infer<typeof slotsQuerySchema>;

export const slotSchema = z.object({ start: z.iso.datetime(), end: z.iso.datetime() });
export type Slot = z.infer<typeof slotSchema>;
export const slotsResponseSchema = z.object({ slots: z.array(slotSchema) });
export type SlotsResponse = z.infer<typeof slotsResponseSchema>;
