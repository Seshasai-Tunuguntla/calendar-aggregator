import { Router, type RequestHandler } from 'express';
import { deleteAccountRequestSchema, type DeleteAccountResponse } from '@calendar-aggregator/shared';
import type { Db } from '../db.ts';
import { sessionCookie } from '../auth/sessions.ts';
import { providerFor, type CalendarProviders } from '../calendar/syncCalendars.ts';
import { revokeGoogleAccess, type GoogleRevoker } from '../google/revoke.ts';
import { currentUser } from '../middleware/auth.ts';
import { HttpError } from '../utils/httpError.ts';

// DELETE /api/account: "Delete my account" (docs/PLAN.md). In this order, because each step needs
// what the next one removes:
// 1. Delete the calendar events of upcoming bookings (sendUpdates=all, so Google tells each guest
//    the meeting is off). Needs the Google tokens.
// 2. Revoke our access to every Google account.
// 3. Delete all of the user's data in one transaction.
// 4. End the session.
// Steps 1 and 2 are best effort: Google being down must not stop someone deleting their data.
// The response says what couldn't be done at Google.
export function accountRouter({
  db,
  requireAuth,
  providers,
  google,
  production,
  now,
}: {
  db: Db;
  requireAuth: RequestHandler;
  providers: CalendarProviders;
  google: GoogleRevoker | null;
  production: boolean;
  now: () => Date;
}): Router {
  const router = Router();
  router.use(requireAuth);

  router.delete('/', async (req, res) => {
    const user = currentUser(req);
    const { confirmHandle } = deleteAccountRequestSchema.parse(req.body);
    // Visitors share the demo host; the reset restores anything they change, but not a deletion.
    if (user.isDemo) throw new HttpError(403, "The demo account can't be deleted");
    if (confirmHandle !== user.handle) throw new HttpError(400, `Type your handle, ${user.handle}, to confirm`);

    // 1.
    const upcoming = await db.booking.findMany({
      where: { hostId: user.id, status: 'CONFIRMED', startsAt: { gt: now() }, externalEventId: { not: null } },
      select: {
        externalEventId: true,
        calendar: { select: { externalCalendarId: true, connection: { select: { id: true, userId: true, provider: true } } } },
      },
    });
    let eventsNotDeleted = 0;
    for (const booking of upcoming) {
      try {
        if (!booking.calendar || !booking.externalEventId) throw new Error('The calendar is no longer connected');
        const { connection, externalCalendarId } = booking.calendar;
        await providerFor(providers, connection).deleteEvent(connection, externalCalendarId, booking.externalEventId);
      } catch (error) {
        eventsNotDeleted++;
        console.error('Deleting a booking event during account deletion failed:', error instanceof Error ? error.message : error);
      }
    }

    // 2.
    const connections = await db.calendarConnection.findMany({ where: { userId: user.id, provider: 'GOOGLE' } });
    const revoked = await Promise.all(connections.map((connection) => revokeGoogleAccess(google, connection)));

    // 3. Bookings first: they restrict deleting event types. Deleting the user cascades to
    // everything else (sessions, connections and their tokens, calendars, rules, event types).
    await db.$transaction([db.booking.deleteMany({ where: { hostId: user.id } }), db.user.delete({ where: { id: user.id } })]);

    // 4. The session row is already gone (cascade); this clears the browser's cookie.
    const cookie = sessionCookie(production);
    res.clearCookie(cookie.name, cookie.options);
    res.json({ revokedAtGoogle: revoked.length > 0 && revoked.every(Boolean), eventsNotDeleted } satisfies DeleteAccountResponse);
  });

  return router;
}
