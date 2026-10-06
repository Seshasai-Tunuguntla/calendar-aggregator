import { useEffect, useRef, useState } from 'react';
import { createBookingRequestSchema, type Slot } from '@calendar-aggregator/shared';
import { errorMessage } from '../api/client.ts';
import { Button } from '../components/Button.tsx';
import { Field } from '../components/Field.tsx';
import { Notice } from '../components/Notice.tsx';
import { guestLongDate, guestTime } from './guestTime.ts';

export interface GuestDetails {
  guestName: string;
  guestEmail: string;
}

// The guest's name and email for the picked time, checked with the same schema as the API before
// anything is sent. onSubmit's errors are shown here; the page deals with "just taken" itself.
export function BookingForm({
  slot,
  timeZone,
  hostName,
  hostTimeZone,
  initial,
  onSubmit,
}: {
  slot: Slot;
  timeZone: string;
  hostName: string;
  hostTimeZone: string;
  initial?: GuestDetails;
  onSubmit: (details: GuestDetails) => Promise<void>;
}) {
  const [values, setValues] = useState<GuestDetails>(initial ?? { guestName: '', guestEmail: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof GuestDetails, string>>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);

  // Moving focus to the form tells screen-reader users the time was picked. (The page gives each
  // picked time its own form, so this runs once per pick.)
  useEffect(() => heading.current?.focus(), []);

  const submit = async () => {
    setFailure(null);
    const checked = createBookingRequestSchema.pick({ guestName: true, guestEmail: true }).safeParse(values);
    if (!checked.success) {
      const next: Partial<Record<keyof GuestDetails, string>> = {};
      for (const issue of checked.error.issues) {
        const key = issue.path[0] as keyof GuestDetails;
        next[key] ??= issue.message;
      }
      setErrors(next);
      // Take the guest straight to the first thing to fix.
      const first = (['guestName', 'guestEmail'] as const).find((key) => next[key]);
      if (first) (form.current?.elements.namedItem(first) as HTMLInputElement | null)?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await onSubmit(checked.data);
    } catch (error) {
      setFailure(errorMessage(error));
    }
    setBusy(false);
  };

  // By the clock, not the zone's name: Asia/Calcutta and Asia/Kolkata are the same place.
  const differentZone = guestTime(slot.start, hostTimeZone) !== guestTime(slot.start, timeZone);
  return (
    <form
      ref={form}
      className="booking-form"
      noValidate
      aria-labelledby="booking-form-title"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 id="booking-form-title" ref={heading} tabIndex={-1}>
        {guestLongDate(slot.start, timeZone)}, {guestTime(slot.start, timeZone)}–{guestTime(slot.end, timeZone)}
      </h2>
      {differentZone && (
        <p className="muted">
          That's {guestTime(slot.start, hostTimeZone)} for {hostName}.
        </p>
      )}
      <div className="booking-form__fields">
        <Field label="Your name" error={errors.guestName ?? null}>
          {(control) => (
            <input {...control} name="guestName" className="input" autoComplete="name" value={values.guestName} onChange={(e) => setValues((v) => ({ ...v, guestName: e.target.value }))} />
          )}
        </Field>
        <Field label="Email for the invitation" error={errors.guestEmail ?? null}>
          {(control) => (
            <input
              {...control}
              name="guestEmail"
              className="input"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={values.guestEmail}
              onChange={(e) => setValues((v) => ({ ...v, guestEmail: e.target.value }))}
            />
          )}
        </Field>
      </div>
      {failure && (
        <Notice tone="danger">
          <p>{failure}</p>
        </Notice>
      )}
      <Button type="submit" variant="primary" busy={busy}>
        Book this time
      </Button>
      <p className="fine-print">You'll get a link to cancel or reschedule.</p>
    </form>
  );
}
