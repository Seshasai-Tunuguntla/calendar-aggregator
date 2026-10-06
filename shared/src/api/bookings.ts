import { z } from 'zod';
import { timeZoneSchema } from '../time/timeZone.ts';

const instant = z.iso.datetime({ offset: true });

// POST /api/public/book/:handle/:slug/bookings
export const createBookingRequestSchema = z.object({
  start: instant,
  guestName: z.string().trim().min(1, 'Enter your name').max(100, 'Names can be at most 100 characters'),
  guestEmail: z.string().trim().toLowerCase().max(254, 'Enter a valid email address').pipe(z.email('Enter a valid email address')),
  guestTimeZone: timeZoneSchema,
});
export type CreateBookingRequest = z.input<typeof createBookingRequestSchema>;

// POST /api/public/bookings/:token/reschedule
export const rescheduleBookingRequestSchema = z.object({ start: instant });
export type RescheduleBookingRequest = z.infer<typeof rescheduleBookingRequestSchema>;

export const bookingStatusSchema = z.enum(['CONFIRMED', 'CANCELLED']);

// What the guest sees through their manage link: their own booking, nothing else of the host's.
export const guestBookingSchema = z.object({
  status: bookingStatusSchema,
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  guestName: z.string(),
  guestEmail: z.string(),
  guestTimeZone: z.string(),
  host: z.object({ name: z.string(), timeZone: z.string() }),
  eventType: z.object({ title: z.string(), durationMinutes: z.int(), bookingPath: z.string() }),
  // Cancelling and rescheduling are open until the meeting starts.
  canChange: z.boolean(),
});
export type GuestBooking = z.infer<typeof guestBookingSchema>;

// GET /api/public/bookings/:token, and the result of cancel and reschedule.
export const guestBookingResponseSchema = z.object({ booking: guestBookingSchema });
export type GuestBookingResponse = z.infer<typeof guestBookingResponseSchema>;

// The answer to a new booking. The manage token is shown this once (only its hash is stored): the
// confirmation page links to managePath, '/booking/<token>'.
export const createBookingResponseSchema = z.object({ booking: guestBookingSchema, manageToken: z.string(), managePath: z.string() });
export type CreateBookingResponse = z.infer<typeof createBookingResponseSchema>;

// The host's view of a booking (GET /api/bookings).
export const hostBookingSchema = z.object({
  id: z.uuid(),
  status: bookingStatusSchema,
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  guestName: z.string(),
  guestEmail: z.string(),
  guestTimeZone: z.string(),
  // Cancelled, but the event couldn't be removed from the host's calendar (their Google access had
  // expired): "cancelled, still on your calendar". Removed automatically once they reconnect.
  stillOnCalendar: z.boolean(),
  eventType: z.object({ id: z.uuid(), title: z.string() }),
});
export type HostBooking = z.infer<typeof hostBookingSchema>;

// GET /api/bookings?cursor=: upcoming confirmed bookings, and cancelled ones still on the host's
// calendar, soonest first, a page at a time.
export const hostBookingsResponseSchema = z.object({ bookings: z.array(hostBookingSchema), nextCursor: z.uuid().nullable() });
export type HostBookingsResponse = z.infer<typeof hostBookingsResponseSchema>;
export const hostBookingResponseSchema = z.object({ booking: hostBookingSchema });
export type HostBookingResponse = z.infer<typeof hostBookingResponseSchema>;
