import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { guestBookingResponseSchema, type GuestBooking, type Slot } from '@calendar-aggregator/shared';
import { ApiRequestError, apiGet, apiSend, errorMessage } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { Button } from '../components/Button.tsx';
import { Notice } from '../components/Notice.tsx';
import { ErrorState, LoadingState } from '../components/States.tsx';
import { guestLongDate, guestLongDateWithYear, guestTime, zoneLabel } from '../guest/guestTime.ts';
import { usePrivatePage } from '../guest/privatePage.ts';
import { TimePicker } from '../guest/TimePicker.tsx';
import { TimeZonePicker } from '../guest/TimeZonePicker.tsx';
import { useSlots } from '../guest/useSlots.ts';
import { GuestFooter } from './BookingPage.tsx';

// /booking/:token, the guest's manage page. The token in the URL is the only key to the booking,
// so the page asks browsers not to send it on as a Referer and search engines not to index it.
export function ManageBookingPage() {
  usePrivatePage();
  const { token = '' } = useParams();
  const page = useApi((signal) => apiGet(`/api/public/bookings/${encodeURIComponent(token)}`, guestBookingResponseSchema, { signal }), [token]);
  const [updated, setUpdated] = useState<GuestBooking | null>(null);

  if (page.error instanceof ApiRequestError && page.error.status === 404) {
    return (
      <main className="page guest" id="main">
        <div className="manage">
          <header>
            <p className="eyebrow">Booking</p>
            <h1>This link doesn't work</h1>
          </header>
          <p className="lead">{page.error.message} If you booked recently, the link is in your confirmation screen; the invitation doesn't include it.</p>
        </div>
        <GuestFooter />
      </main>
    );
  }
  if (!page.data) {
    return (
      <main className="page guest" id="main">
        {page.error ? <ErrorState error={page.error} onRetry={page.reload} /> : <LoadingState label="Loading your booking…" />}
      </main>
    );
  }
  return <Manage token={token} booking={updated ?? page.data.booking} onUpdated={setUpdated} />;
}

type Panel = 'cancel' | 'reschedule';
type Mode = { kind: 'view'; message?: string; closed?: Panel } | { kind: Panel };

// Opening a panel puts keyboard and screen-reader users on its heading (stable, so it runs once per mount).
const focusOnMount = (el: HTMLElement | null) => el?.focus();

function Manage({ token, booking, onUpdated }: { token: string; booking: GuestBooking; onUpdated: (b: GuestBooking) => void }) {
  const [timeZone, setTimeZone] = useState(booking.guestTimeZone);
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/public/bookings/${encodeURIComponent(token)}`;
  const messageBox = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);

  // Back in the view: on the outcome's message, or on the button that opened the panel just closed.
  useEffect(() => {
    if (mode.kind !== 'view') return;
    if (mode.message) messageBox.current?.focus();
    else if (mode.closed) actions.current?.querySelector<HTMLElement>(`[data-opens="${mode.closed}"]`)?.focus();
  }, [mode]);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const { booking: cancelled } = await apiSend('POST', `${base}/cancel`, undefined, guestBookingResponseSchema);
      onUpdated(cancelled);
      setMode({ kind: 'view', message: `Cancelled. ${booking.host.name}'s calendar has been updated.` });
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  };

  const cancelled = booking.status === 'CANCELLED';
  return (
    <main className="page guest" id="main">
      <div className="manage">
        <header>
          <p className="eyebrow">{cancelled ? 'Cancelled' : 'Your booking'}</p>
          <h1>
            {booking.eventType.title} with {booking.host.name}
          </h1>
        </header>
        {mode.kind === 'view' && mode.message && (
          <div ref={messageBox} tabIndex={-1} className="focus-target">
            <Notice tone="success">
              <p>{mode.message}</p>
            </Notice>
          </div>
        )}
        <dl className="facts">
          <div>
            <dt>When</dt>
            <dd className={cancelled ? 'struck' : undefined}>
              {guestLongDateWithYear(booking.start, timeZone)}
              <br />
              {guestTime(booking.start, timeZone)}–{guestTime(booking.end, timeZone)}, {zoneLabel(timeZone, new Date(booking.start))}
            </dd>
          </div>
          <div>
            <dt>Name</dt>
            <dd>{booking.guestName}</dd>
          </div>
          <div>
            <dt>Invitation to</dt>
            <dd>{booking.guestEmail}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{cancelled ? 'Cancelled' : booking.canChange ? 'Confirmed' : 'Confirmed; the meeting has started, so it can no longer be changed'}</dd>
          </div>
        </dl>
        <TimeZonePicker timeZone={timeZone} onChange={setTimeZone} />

        {error && (
          <Notice tone="danger">
            <p>{error}</p>
          </Notice>
        )}

        {cancelled ? (
          <p className="manage__actions">
            <Link className="button button--primary" to={booking.eventType.bookingPath}>
              Book a new time
            </Link>
          </p>
        ) : booking.canChange && mode.kind === 'view' ? (
          <div className="manage__actions" ref={actions}>
            <Button variant="primary" data-opens="reschedule" onClick={() => setMode({ kind: 'reschedule' })}>
              Reschedule
            </Button>
            <Button variant="secondary" data-opens="cancel" onClick={() => setMode({ kind: 'cancel' })}>
              Cancel booking
            </Button>
          </div>
        ) : null}

        {mode.kind === 'cancel' && !cancelled && (
          <div className="panel panel--danger">
            <h2 className="panel__title focus-target" ref={focusOnMount} tabIndex={-1}>
              Cancel this booking?
            </h2>
            <p>
              {booking.host.name}'s calendar is updated{booking.host.isDemo ? '.' : ' and Google emails you the cancellation.'}
            </p>
            <div className="manage__actions">
              <Button variant="danger" busy={busy} onClick={cancel}>
                Cancel booking
              </Button>
              <Button variant="quiet" disabled={busy} onClick={() => setMode({ kind: 'view', closed: 'cancel' })}>
                Keep it
              </Button>
            </div>
          </div>
        )}

        {mode.kind === 'reschedule' && (
          <Reschedule
            base={base}
            booking={booking}
            timeZone={timeZone}
            onDone={(moved) => {
              onUpdated(moved);
              setMode({ kind: 'view', message: booking.host.isDemo ? 'Moved.' : 'Moved. Google Calendar emails you the new time.' });
            }}
            onClose={() => setMode({ kind: 'view', closed: 'reschedule' })}
          />
        )}
      </div>
      <GuestFooter />
    </main>
  );
}

function Reschedule({
  base,
  booking,
  timeZone,
  onDone,
  onClose,
}: {
  base: string;
  booking: GuestBooking;
  timeZone: string;
  onDone: (b: GuestBooking) => void;
  onClose: () => void;
}) {
  const slots = useSlots(booking.eventType.bookingPath, timeZone);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'warning' | 'danger'; text: string } | null>(null);
  const messageBox = useRef<HTMLDivElement>(null);

  // The picked time is gone (and the button with it disabled): put the guest on the message.
  useEffect(() => {
    if (message) messageBox.current?.focus();
  }, [message]);

  const move = async () => {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      const { booking: moved } = await apiSend('POST', `${base}/reschedule`, { start: selected.start }, guestBookingResponseSchema);
      onDone(moved);
    } catch (error) {
      // A conflict (the time was taken, or stopped being free): show why and refresh the times.
      if (error instanceof ApiRequestError && error.status === 409) {
        setMessage({ tone: 'warning', text: `${error.message} The times below are up to date.` });
        setSelected(null);
        await slots.refresh().catch(() => {});
      } else {
        setMessage({ tone: 'danger', text: errorMessage(error) });
      }
    }
    setBusy(false);
  };

  return (
    <section className="panel reschedule" aria-labelledby="reschedule-title">
      <h2 id="reschedule-title" className="panel__title focus-target" ref={focusOnMount} tabIndex={-1}>
        Pick a new time
      </h2>
      <p className="muted">Your current time isn't offered, and neither is one that overlaps it.</p>
      {message && (
        <div ref={messageBox} tabIndex={-1} className="focus-target">
          <Notice tone={message.tone}>
            <p>{message.text}</p>
          </Notice>
        </div>
      )}
      <TimePicker slots={slots} timeZone={timeZone} selected={selected} onSelect={setSelected} />
      <div className="manage__actions">
        <Button variant="primary" busy={busy} disabled={!selected} onClick={move}>
          {selected ? `Move to ${guestLongDate(selected.start, timeZone)}, ${guestTime(selected.start, timeZone)}` : 'Move here'}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onClose}>
          Keep my current time
        </Button>
      </div>
    </section>
  );
}
