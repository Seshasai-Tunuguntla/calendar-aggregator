import { useState } from 'react';
import { Link } from 'react-router';
import {
  bookingPageStatusSchema,
  connectionsResponseSchema,
  eventTypesResponseSchema,
  hostBookingsResponseSchema,
  type BookingPageStatus,
  type Connection,
  type HostBooking,
} from '@calendar-aggregator/shared';
import { apiGet, apiSend, errorMessage } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useSignedInUser } from '../auth/AuthContext.tsx';
import { Button, ButtonLink } from '../components/Button.tsx';
import { CopyButton } from '../components/CopyButton.tsx';
import { Notice } from '../components/Notice.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { EmptyState, ErrorState, LoadingState } from '../components/States.tsx';
import { bookingUrl, formatDay, formatTime, greeting } from '../format.ts';
import { googleStartUrl } from '../signInErrors.ts';

const reconnectUrl = (email: string) => googleStartUrl({ intent: 'connect', hint: email });

export function DashboardPage() {
  const user = useSignedInUser();
  const page = useApi(
    async (signal) => {
      const [status, connections, bookings, eventTypes] = await Promise.all([
        apiGet('/api/booking-page/status', bookingPageStatusSchema, { signal }),
        apiGet('/api/connections', connectionsResponseSchema, { signal }),
        apiGet('/api/bookings', hostBookingsResponseSchema, { signal }),
        apiGet('/api/event-types', eventTypesResponseSchema, { signal }),
      ]);
      return { status, connections: connections.connections, bookings, eventTypes: eventTypes.eventTypes };
    },
    [],
  );

  // Read once: the greeting and date shouldn't change under the host while they read.
  const [today] = useState(() => new Date());
  const firstName = user.name.split(' ')[0] ?? user.name;
  const header = <PageHeader eyebrow={formatDay(today.toISOString(), user.timeZone)} title={`${greeting(user.timeZone, today)}, ${firstName}`} />;

  if (!page.data) {
    return (
      <>
        {header}
        {page.error ? <ErrorState error={page.error} onRetry={page.reload} /> : <LoadingState label="Loading your dashboard…" />}
      </>
    );
  }

  const { status, connections, bookings, eventTypes } = page.data;
  const active = eventTypes.filter((e) => e.active);
  return (
    <>
      {header}
      <div className="stack">
        {user.isDemo && (
          <Notice tone="info" title="You're trying the demo host">
            <p>Visitors share this account and it resets regularly, so feel free to change anything. Nothing is sent to anyone.</p>
          </Notice>
        )}
        <CalendarProblemNotice problem={status.calendarProblem} onRetry={page.reload} />
        <ReconnectNotices connections={connections} skip={status.calendarProblem?.kind === 'reconnect' ? status.calendarProblem.accountEmail : null} />
        <StillOnCalendarNotice bookings={bookings.bookings.filter((b) => b.stillOnCalendar)} connections={connections} timeZone={user.timeZone} />
        <SetupNotices status={status} />
      </div>
      <div className="columns">
        <section aria-labelledby="coming-up">
          <h2 id="coming-up" className="section-title">
            Coming up
          </h2>
          <UpcomingBookings first={bookings} timeZone={user.timeZone} onChange={page.reload} />
        </section>
        <aside className="panel" aria-labelledby="links">
          <h2 id="links" className="panel__title">
            Your booking links
          </h2>
          {active.length === 0 ? (
            <p>
              No event types are on yet. <Link to="/event-types">Create one</Link> to get a link to share.
            </p>
          ) : (
            <ul className="link-list">
              {active.map((eventType) => (
                <li key={eventType.id}>
                  <p className="link-list__title">{eventType.title}</p>
                  <code className="link-list__url">{bookingUrl(eventType.bookingPath)}</code>
                  <CopyButton text={bookingUrl(eventType.bookingPath)} />
                </li>
              ))}
            </ul>
          )}
          <p className="fine-print">Guests only ever see free times, never your events.</p>
        </aside>
      </div>
    </>
  );
}

// The warning asked for in the phase 6 review: the booking page is showing no times because a
// calendar that counts as busy can't be checked (it fails closed).
function CalendarProblemNotice({ problem, onRetry }: { problem: BookingPageStatus['calendarProblem']; onRetry: () => void }) {
  if (!problem) return null;
  const which = problem.calendarName ? `${problem.calendarName}${problem.accountEmail ? ` (${problem.accountEmail})` : ''}` : null;
  const title = "Your booking page isn't showing times";
  if (problem.kind === 'reconnect') {
    return (
      <Notice
        tone="danger"
        title={title}
        action={problem.accountEmail && <ButtonLink variant="primary" href={reconnectUrl(problem.accountEmail)}>Reconnect Google</ButtonLink>}
      >
        <p>Google access for {problem.accountEmail ?? 'one of your accounts'} has expired or was removed, so its calendars can't be checked. Reconnect it to show times again.</p>
      </Notice>
    );
  }
  if (problem.kind === 'unreadable') {
    return (
      <Notice tone="danger" title={title} action={<Link className="button button--primary" to="/calendars">Go to calendars</Link>}>
        <p>{which ?? 'A calendar'} counts as busy but doesn't share its busy times, so no times can be shown. Untick it on your calendars page.</p>
      </Notice>
    );
  }
  return (
    <Notice tone="warning" title={title} action={<Button onClick={onRetry}>Check again</Button>}>
      <p>{which ?? 'Your calendars'} can't be checked right now, so guests see no times until it works again. This usually fixes itself within minutes.</p>
    </Notice>
  );
}

function ReconnectNotices({ connections, skip }: { connections: Connection[]; skip: string | null }) {
  const expired = connections.filter((c) => c.status === 'NEEDS_RECONNECT' && c.accountEmail !== skip);
  return expired.map((connection) => (
    <Notice key={connection.id} tone="warning" title="Reconnect Google" action={<ButtonLink variant="primary" href={reconnectUrl(connection.accountEmail)}>Reconnect</ButtonLink>}>
      <p>Access to {connection.accountEmail} has expired or was removed. Its calendars can't be checked, and bookings can't be added to them, until you reconnect.</p>
    </Notice>
  ));
}

// Asked for in the phase 7 review: bookings cancelled while Google access had expired, whose
// events are still on the host's calendar until they reconnect.
function StillOnCalendarNotice({ bookings, connections, timeZone }: { bookings: HostBooking[]; connections: Connection[]; timeZone: string }) {
  if (bookings.length === 0) return null;
  const expired = connections.find((c) => c.status === 'NEEDS_RECONNECT');
  return (
    <Notice
      tone="warning"
      title="Cancelled, still on your calendar"
      action={expired && <ButtonLink variant="primary" href={reconnectUrl(expired.accountEmail)}>Reconnect Google</ButtonLink>}
    >
      <ul className="plain-list">
        {bookings.map((b) => (
          <li key={b.id}>
            {b.guestName} cancelled <strong>{formatDay(b.start, timeZone)}, {formatTime(b.start, timeZone)}</strong> ({b.eventType.title}).
          </li>
        ))}
      </ul>
      <p>
        {expired
          ? `Google access had expired, so ${bookings.length === 1 ? 'its event is' : 'their events are'} still on your calendar. Reconnect and we'll remove ${bookings.length === 1 ? 'it' : 'them'}, or delete ${bookings.length === 1 ? 'it' : 'them'} yourself.`
          : `We'll remove ${bookings.length === 1 ? 'the event' : 'the events'} from your calendar the next time you refresh your calendars, or you can delete ${bookings.length === 1 ? 'it' : 'them'} yourself.`}
      </p>
    </Notice>
  );
}

function SetupNotices({ status }: { status: BookingPageStatus }) {
  return (
    <>
      {!status.hasHours && (
        <Notice tone="info" title="Set your working hours" action={<Link className="button button--secondary" to="/availability">Set hours</Link>}>
          <p>Guests can only book inside your working hours, and you haven't set any yet.</p>
        </Notice>
      )}
      {status.activeEventTypes === 0 && (
        <Notice tone="info" title="Create an event type" action={<Link className="button button--secondary" to="/event-types">Create one</Link>}>
          <p>An event type (say, a 30-minute call) gives you a booking link to share.</p>
        </Notice>
      )}
    </>
  );
}

function UpcomingBookings({ first, timeZone, onChange }: { first: { bookings: HostBooking[]; nextCursor: string | null }; timeZone: string; onChange: () => void }) {
  const [extra, setExtra] = useState<HostBooking[]>([]);
  const [cursor, setCursor] = useState(first.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const bookings = [...first.bookings, ...extra].filter((b) => b.status === 'CONFIRMED');

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await apiGet(`/api/bookings?cursor=${cursor}`, hostBookingsResponseSchema);
      setExtra((current) => [...current, ...next.bookings]);
      setCursor(next.nextCursor);
    } catch (error) {
      setMoreError(errorMessage(error));
    }
    setLoadingMore(false);
  };

  if (bookings.length === 0) {
    return (
      <EmptyState title="No upcoming bookings">
        When guests book you, their meetings show up here and on your Google Calendar.
      </EmptyState>
    );
  }
  return (
    <>
      <ol className="booking-list">
        {bookings.map((booking) => (
          <BookingRow key={booking.id} booking={booking} timeZone={timeZone} onCancelled={onChange} />
        ))}
      </ol>
      {moreError && (
        <Notice tone="danger">
          <p>{moreError}</p>
        </Notice>
      )}
      {cursor && (
        <Button busy={loadingMore} onClick={loadMore}>
          Show more
        </Button>
      )}
    </>
  );
}

function BookingRow({ booking, timeZone, onCancelled }: { booking: HostBooking; timeZone: string; onCancelled: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiSend('POST', `/api/bookings/${booking.id}/cancel`);
      onCancelled();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <li className="booking-row">
      <p className="booking-row__when">
        <span className="booking-row__day">{formatDay(booking.start, timeZone)}</span>
        <span className="booking-row__time">
          {formatTime(booking.start, timeZone)}–{formatTime(booking.end, timeZone)}
        </span>
      </p>
      <div className="booking-row__what">
        <p>
          {booking.eventType.title} with <strong>{booking.guestName}</strong>
        </p>
        <p className="muted">{booking.guestEmail}</p>
        {error && <p className="field__error">{error}</p>}
      </div>
      <div className="booking-row__actions">
        {confirming ? (
          <div className="confirm" role="group" aria-label={`Cancel the booking with ${booking.guestName}?`}>
            <p className="confirm__question">Cancel it? Google will email {booking.guestName}.</p>
            <Button variant="danger" busy={busy} onClick={cancel}>
              Cancel booking
            </Button>
            <Button variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        ) : (
          <Button variant="quiet" onClick={() => setConfirming(true)}>
            Cancel…
          </Button>
        )}
      </div>
    </li>
  );
}
