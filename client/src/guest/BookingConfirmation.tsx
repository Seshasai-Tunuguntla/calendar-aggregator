import type { GuestBooking } from '@calendar-aggregator/shared';
import { CopyButton } from '../components/CopyButton.tsx';
import { guestLongDateWithYear, guestTime, zoneLabel } from './guestTime.ts';

// After booking: the time in the guest's zone, the manage link (shown this once), and what
// happens next.
export function BookingConfirmation({ booking, manageUrl, timeZone }: { booking: GuestBooking; manageUrl: string; timeZone: string }) {
  return (
    <section className="confirmation" aria-labelledby="confirmation-title">
      <p className="eyebrow">Confirmed</p>
      <h1 id="confirmation-title" tabIndex={-1}>
        You're booked with {booking.host.name}
      </h1>
      <dl className="facts confirmation__facts">
        <div>
          <dt>What</dt>
          <dd>{booking.eventType.title}</dd>
        </div>
        <div>
          <dt>When</dt>
          <dd>
            {guestLongDateWithYear(booking.start, timeZone)}
            <br />
            {guestTime(booking.start, timeZone)}–{guestTime(booking.end, timeZone)}, {zoneLabel(timeZone, new Date(booking.start))}
          </dd>
        </div>
        <div>
          <dt>Invitation to</dt>
          <dd>{booking.guestEmail}</dd>
        </div>
      </dl>

      <div className="panel manage-link">
        <h2 className="panel__title">Your link to change this booking</h2>
        <p>
          Keep it somewhere safe: it's the only way to cancel or reschedule, and anyone who has it can. It isn't in the calendar invitation.
        </p>
        <p className="manage-link__url">
          <code>{manageUrl}</code>
        </p>
        <CopyButton text={manageUrl} label="Copy link" variant="secondary" />
      </div>

      <h2 className="section-title">What happens next</h2>
      <ol className="next-steps">
        {booking.host.isDemo ? (
          <li>This is the demo, so no invitation is sent. With a real host, Google Calendar would email one to {booking.guestEmail}.</li>
        ) : (
          <li>Google Calendar emails an invitation to {booking.guestEmail}. Accept it to add the meeting to your own calendar.</li>
        )}
        <li>To cancel or move it, open your link above. You can until the meeting starts.</li>
        <li>{booking.host.name} has it on their calendar already; there's nothing else to do.</li>
      </ol>
    </section>
  );
}
