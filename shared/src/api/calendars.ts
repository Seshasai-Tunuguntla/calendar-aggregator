import { z } from 'zod';

// Whether a calendar's busy times can be read:
// - READABLE: they can, so it can count as busy.
// - UNREADABLE: the provider won't give them, permanently (Google's holiday calendars, for
//   example), so it can't count as busy.
// - UNKNOWN: not checked yet, or the last check failed for a temporary reason. The UI shows "can't
//   check your calendar right now", not "unreadable".
export const busyAccessSchema = z.enum(['READABLE', 'UNREADABLE', 'UNKNOWN']);
export type BusyAccess = z.infer<typeof busyAccessSchema>;

// A calendar of one of the host's connected accounts. Names are shown to the host only, never on
// public pages.
export const calendarSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  accountEmail: z.string(),
  // NEEDS_RECONNECT: this account's calendars can't be read until the host reconnects it.
  connectionStatus: z.enum(['ACTIVE', 'NEEDS_RECONNECT']),
  name: z.string(),
  isPrimary: z.boolean(),
  countsAsBusy: z.boolean(),
  // The host owns it, so booking events can be created in it.
  canCreateEvents: z.boolean(),
  busyAccess: busyAccessSchema,
});
export type Calendar = z.infer<typeof calendarSchema>;

// GET /api/calendars and POST /api/calendars/sync. bookingCalendarId: where booking events are
// created (the host's choice, or else the primary calendar of their first account); null if they
// own no calendar events can be created in.
export const calendarsResponseSchema = z.object({ calendars: z.array(calendarSchema), bookingCalendarId: z.uuid().nullable() });
export type CalendarsResponse = z.infer<typeof calendarsResponseSchema>;

// PATCH /api/calendars/:id
export const updateCalendarRequestSchema = z.object({ countsAsBusy: z.boolean() });
export type UpdateCalendarRequest = z.infer<typeof updateCalendarRequestSchema>;
export const calendarResponseSchema = z.object({ calendar: calendarSchema });
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;

// PUT /api/calendars/booking-calendar
export const setBookingCalendarRequestSchema = z.object({ calendarId: z.uuid('Calendar not found') });
export type SetBookingCalendarRequest = z.infer<typeof setBookingCalendarRequestSchema>;
