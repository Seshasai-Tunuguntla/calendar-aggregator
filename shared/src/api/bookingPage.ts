import { z } from 'zod';

// GET /api/booking-page/status: whether the host's booking page can show guests any times, for
// the dashboard's warnings. calendarProblem is set when a calendar that counts as busy can't be
// checked, which makes the page show no times at all (it fails closed):
// - temporary: Google is down or slow right now; it usually fixes itself.
// - reconnect: the account's Google access expired or was revoked.
// - unreadable: this calendar doesn't share busy times; untick it.
export const bookingPageStatusSchema = z.object({
  activeEventTypes: z.int().min(0),
  hasHours: z.boolean(),
  calendarProblem: z
    .object({
      kind: z.enum(['temporary', 'reconnect', 'unreadable']),
      calendarName: z.string().nullable(),
      accountEmail: z.string().nullable(),
    })
    .nullable(),
});
export type BookingPageStatus = z.infer<typeof bookingPageStatusSchema>;
