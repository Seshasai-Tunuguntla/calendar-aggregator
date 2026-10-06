import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { createBookingResponseSchema, publicEventTypeResponseSchema, type CreateBookingResponse, type Slot } from '@calendar-aggregator/shared';
import { ApiRequestError, apiGet, apiSend } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { Notice } from '../components/Notice.tsx';
import { ErrorState, LoadingState } from '../components/States.tsx';
import { formatDuration } from '../format.ts';
import { BookingConfirmation } from '../guest/BookingConfirmation.tsx';
import { BookingForm, type GuestDetails } from '../guest/BookingForm.tsx';
import { detectTimeZone } from '../guest/guestTime.ts';
import { TimePicker } from '../guest/TimePicker.tsx';
import { TimeZonePicker } from '../guest/TimeZonePicker.tsx';
import { useSlots } from '../guest/useSlots.ts';
import { NotFoundPage } from './NotFoundPage.tsx';

// The public booking page, /book/:handle/:slug: the screen guests (and recruiters trying the demo)
// see first.
export function BookingPage() {
  const { handle = '', slug = '' } = useParams();
  const bookingPath = `/book/${handle}/${slug}`;
  const info = useApi((signal) => apiGet(`/api/public${bookingPath}`, publicEventTypeResponseSchema, { signal }), [bookingPath]);

  if (info.error instanceof ApiRequestError && info.error.status === 404) return <NotFoundPage title="This booking page doesn't exist" />;
  if (!info.data) {
    return (
      <main className="page guest" id="main">
        {info.error ? <ErrorState error={info.error} onRetry={info.reload} /> : <LoadingState label="Loading the booking page…" />}
      </main>
    );
  }
  return <Booking bookingPath={bookingPath} info={info.data} />;
}

function Booking({ bookingPath, info }: { bookingPath: string; info: { host: { name: string; timeZone: string; isDemo: boolean }; eventType: { title: string; description: string; durationMinutes: number } } }) {
  const [timeZone, setTimeZone] = useState(detectTimeZone);
  const slots = useSlots(bookingPath, timeZone);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [details, setDetails] = useState<GuestDetails | undefined>();
  const [booked, setBooked] = useState<CreateBookingResponse | null>(null);
  const confirmationTop = useRef<HTMLDivElement>(null);
  const takenNotice = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (booked) confirmationTop.current?.querySelector('h1')?.focus();
  }, [booked]);

  // The form the guest was in has gone: put them on the message, just above the fresh times.
  useEffect(() => {
    if (taken) takenNotice.current?.focus();
  }, [taken]);

  const book = async (guest: GuestDetails) => {
    if (!selected) return;
    setDetails(guest);
    try {
      setBooked(await apiSend('POST', `/api/public${bookingPath}/bookings`, { start: selected.start, ...guest, guestTimeZone: timeZone }, createBookingResponseSchema));
    } catch (error) {
      // Someone else got there first (or the time stopped being free): say so, refresh the times
      // and let the guest pick again; their name and email are kept.
      if (error instanceof ApiRequestError && error.status === 409) {
        setTaken(error.message);
        setSelected(null);
        await slots.refresh().catch(() => {});
        return;
      }
      throw error;
    }
  };

  if (booked) {
    return (
      <main className="page guest" id="main">
        <div ref={confirmationTop}>
          <BookingConfirmation
            booking={booked.booking}
            manageUrl={`${window.location.origin}${booked.managePath}`}
            timeZone={timeZone}
          />
        </div>
        <GuestFooter />
      </main>
    );
  }

  return (
    <main className="page guest" id="main">
      <div className="guest__layout">
        <section className="guest__intro">
          <p className="eyebrow">{info.host.name}</p>
          <h1>{info.eventType.title}</h1>
          {info.eventType.description && <p className="lead">{info.eventType.description}</p>}
          <dl className="facts">
            <div>
              <dt>Length</dt>
              <dd>{formatDuration(info.eventType.durationMinutes)}</dd>
            </div>
            <div>
              <dt>Invitation</dt>
              <dd>{info.host.isDemo ? 'None: this is the demo' : 'From Google Calendar'}</dd>
            </div>
          </dl>
          {info.host.isDemo && (
            <Notice tone="info" title="This is the demo">
              <p>Book any time to see how it works. Nothing is sent to anyone.</p>
            </Notice>
          )}
        </section>
        <section className="guest__picker" aria-label="Choose a time">
          <TimeZonePicker
            timeZone={timeZone}
            onChange={(zone) => {
              setTimeZone(zone);
              setSelected(null);
            }}
          />
          {taken && (
            <div ref={takenNotice} tabIndex={-1} className="focus-target">
              <Notice tone="warning" title="Please pick another time">
                <p>{taken} The times below are up to date.</p>
              </Notice>
            </div>
          )}
          <TimePicker
            slots={slots}
            timeZone={timeZone}
            selected={selected}
            onSelect={(slot) => {
              setSelected(slot);
              setTaken(null);
            }}
          />
          {selected && (
            <BookingForm
              key={selected.start}
              slot={selected}
              timeZone={timeZone}
              hostName={info.host.name}
              hostTimeZone={info.host.timeZone}
              {...(details ? { initial: details } : {})}
              onSubmit={book}
            />
          )}
        </section>
      </div>
      <GuestFooter />
    </main>
  );
}

export function GuestFooter() {
  return <p className="guest__footer fine-print">Booked with Calendar Aggregator. You only ever see free times, never anyone's events.</p>;
}
