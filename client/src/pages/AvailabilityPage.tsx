import { useState } from 'react';
import { Link } from 'react-router';
import {
  availabilitySchema,
  eventTypesResponseSchema,
  formatMinute,
  slotsResponseSchema,
  type Availability,
  type EventType,
  type WeeklyRule,
} from '@calendar-aggregator/shared';
import { apiGet, apiSend, errorMessage } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useSignedInUser } from '../auth/AuthContext.tsx';
import { Button } from '../components/Button.tsx';
import { Field } from '../components/Field.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { EmptyState, ErrorState, LoadingState } from '../components/States.tsx';
import { formatDay, formatDuration, formatTime, timeZoneLabel } from '../format.ts';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
// Rule times in 15-minute steps, 00:00 to 24:00 (end of the day).
const QUARTERS = Array.from({ length: 97 }, (_, i) => i * 15);
const BUFFERS = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
const NOTICE = [0, 15, 30, 60, 120, 240, 480, 720, 1440, 2880, 4320, 10_080, 20_160, 43_200];

const withValue = (options: number[], value: number) => (options.includes(value) ? options : [...options, value].toSorted((a, b) => a - b));

export function AvailabilityPage() {
  const page = useApi(async (signal) => {
    const [availability, eventTypes] = await Promise.all([
      apiGet('/api/availability', availabilitySchema, { signal }),
      apiGet('/api/event-types', eventTypesResponseSchema, { signal }),
    ]);
    return { availability, eventTypes: eventTypes.eventTypes };
  }, []);

  const header = (
    <PageHeader eyebrow="Availability" title="When guests can book you">
      <p>Your weekly hours, in your own time zone. Times your calendars show as busy are always left out.</p>
    </PageHeader>
  );
  if (!page.data) {
    return (
      <>
        {header}
        {page.error ? <ErrorState error={page.error} onRetry={page.reload} /> : <LoadingState label="Loading your hours…" />}
      </>
    );
  }
  return (
    <>
      {header}
      <Editor initial={page.data.availability} eventType={page.data.eventTypes.find((e) => e.active) ?? null} />
    </>
  );
}

function Editor({ initial, eventType }: { initial: Availability; eventType: EventType | null }) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(0);
  const zones = Intl.supportedValuesOf('timeZone');

  const setRules = (rules: WeeklyRule[]) => setDraft((d) => ({ ...d, rules }));
  const setSetting = <K extends keyof Availability['settings']>(key: K, value: Availability['settings'][K]) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, [key]: value } }));

  const save = async () => {
    setError(null);
    // The same schema the API validates with: same rules, same messages, no round trip.
    const checked = availabilitySchema.safeParse(draft);
    if (!checked.success) {
      setError(checked.error.issues[0]?.message ?? 'Check your hours');
      return;
    }
    setSaving(true);
    try {
      setDraft(await apiSend('PUT', '/api/availability', checked.data, availabilitySchema));
      setSaved((n) => n + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setSaving(false);
  };

  return (
    <form
      className="availability"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <section className="panel" aria-labelledby="hours">
        <h2 id="hours" className="panel__title">
          Weekly hours
        </h2>
        <Field label="Your time zone" hint="Your hours below are in this zone. Guests see times in theirs.">
          {(control) => (
            <select {...control} className="select" value={draft.timeZone} onChange={(e) => setDraft((d) => ({ ...d, timeZone: e.target.value }))}>
              {(zones.includes(draft.timeZone) ? zones : [draft.timeZone, ...zones]).map((zone) => (
                <option key={zone} value={zone}>
                  {timeZoneLabel(zone)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <ol className="week">
          {WEEKDAYS.map((name, index) => (
            <DayRules key={name} weekday={index + 1} name={name} rules={draft.rules} onChange={setRules} />
          ))}
        </ol>
      </section>

      <section className="panel" aria-labelledby="settings">
        <h2 id="settings" className="panel__title">
          Around each booking
        </h2>
        <div className="settings-grid">
          <Field label="Free time before" hint="Kept clear before each meeting.">
            {(control) => (
              <select {...control} className="select" value={draft.settings.bufferBeforeMinutes} onChange={(e) => setSetting('bufferBeforeMinutes', Number(e.target.value))}>
                {withValue(BUFFERS, draft.settings.bufferBeforeMinutes).map((m) => (
                  <option key={m} value={m}>
                    {formatDuration(m)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Free time after" hint="Kept clear after each meeting.">
            {(control) => (
              <select {...control} className="select" value={draft.settings.bufferAfterMinutes} onChange={(e) => setSetting('bufferAfterMinutes', Number(e.target.value))}>
                {withValue(BUFFERS, draft.settings.bufferAfterMinutes).map((m) => (
                  <option key={m} value={m}>
                    {formatDuration(m)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Minimum notice" hint="How soon before a meeting guests can still book it.">
            {(control) => (
              <select {...control} className="select" value={draft.settings.minNoticeMinutes} onChange={(e) => setSetting('minNoticeMinutes', Number(e.target.value))}>
                {withValue(NOTICE, draft.settings.minNoticeMinutes).map((m) => (
                  <option key={m} value={m}>
                    {formatDuration(m)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Book up to (days ahead)" hint="1 to 365 days.">
            {(control) => (
              <input
                {...control}
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                value={draft.settings.horizonDays}
                onChange={(e) => setSetting('horizonDays', Math.trunc(Number(e.target.value)))}
              />
            )}
          </Field>
        </div>
        <div className="checkbox">
          <input
            id="limit-per-day"
            type="checkbox"
            checked={draft.settings.maxPerDay !== null}
            onChange={(e) => setSetting('maxPerDay', e.target.checked ? 4 : null)}
          />
          <label htmlFor="limit-per-day">Limit bookings per day</label>
        </div>
        {draft.settings.maxPerDay !== null && (
          <Field label="At most this many a day" hint="1 to 50.">
            {(control) => (
              <input
                {...control}
                className="input input--short"
                type="number"
                inputMode="numeric"
                min={1}
                max={50}
                value={draft.settings.maxPerDay ?? 1}
                onChange={(e) => setSetting('maxPerDay', Math.trunc(Number(e.target.value)))}
              />
            )}
          </Field>
        )}
      </section>

      <div className="form-actions" aria-live="polite">
        <Button type="submit" variant="primary" busy={saving}>
          Save hours
        </Button>
        {error && <p className="field__error">{error}</p>}
        {saved > 0 && !error && !saving && <p className="status status--ok">Saved. Your booking page uses these now.</p>}
      </div>

      <Preview eventType={eventType} version={saved} />
    </form>
  );
}

// One weekday's ranges. Each range is a start and end in 15-minute steps; 24:00 means the end of
// the day. Overlaps and the like are caught by the shared schema on save.
function DayRules({ weekday, name, rules, onChange }: { weekday: number; name: string; rules: WeeklyRule[]; onChange: (rules: WeeklyRule[]) => void }) {
  const mine = rules.filter((r) => r.weekday === weekday).toSorted((a, b) => a.startMinute - b.startMinute);
  const others = rules.filter((r) => r.weekday !== weekday);
  const replace = (index: number, rule: WeeklyRule | null) =>
    onChange([...others, ...mine.flatMap((r, i) => (i === index ? (rule ? [rule] : []) : [r]))]);
  const add = () => {
    const last = mine.at(-1);
    const start = last ? Math.min(last.endMinute + 60, 1380) : 540;
    onChange([...others, ...mine, { weekday, startMinute: start, endMinute: Math.min(start + 60 * (last ? 2 : 8), 1440) }]);
  };

  return (
    <li className="day">
      <p className="day__name">{name}</p>
      <div className="day__ranges">
        {mine.length === 0 && <p className="muted">Unavailable</p>}
        {mine.map((rule, index) => (
          <div className="range" key={`${rule.startMinute}-${index}`}>
            <label className="sr-only" htmlFor={`d${weekday}-${index}-start`}>
              {name}, from
            </label>
            <select id={`d${weekday}-${index}-start`} className="select select--time" value={rule.startMinute} onChange={(e) => replace(index, { ...rule, startMinute: Number(e.target.value) })}>
              {withValue(QUARTERS.slice(0, -1), rule.startMinute).map((m) => (
                <option key={m} value={m}>
                  {formatMinute(m)}
                </option>
              ))}
            </select>
            <span aria-hidden="true">to</span>
            <label className="sr-only" htmlFor={`d${weekday}-${index}-end`}>
              {name}, until
            </label>
            <select id={`d${weekday}-${index}-end`} className="select select--time" value={rule.endMinute} onChange={(e) => replace(index, { ...rule, endMinute: Number(e.target.value) })}>
              {withValue(QUARTERS.slice(1), rule.endMinute).map((m) => (
                <option key={m} value={m}>
                  {formatMinute(m)}
                </option>
              ))}
            </select>
            <Button variant="quiet" onClick={() => replace(index, null)} aria-label={`Remove ${name} ${formatMinute(rule.startMinute)} to ${formatMinute(rule.endMinute)}`}>
              Remove
            </Button>
          </div>
        ))}
      </div>
      <Button variant="quiet" onClick={add} aria-label={`Add hours on ${name}`}>
        + Add hours
      </Button>
    </li>
  );
}

// What guests see over the next week for the first active event type, from the same endpoint the
// booking page uses: saved hours, minus busy times.
function Preview({ eventType, version }: { eventType: EventType | null; version: number }) {
  const user = useSignedInUser();
  const dates = nextWeek(user.timeZone);
  const slots = useApi(
    (signal) =>
      eventType
        ? apiGet(`/api/public${eventType.bookingPath}/slots?${new URLSearchParams({ from: dates.from, to: dates.to, tz: user.timeZone })}`, slotsResponseSchema, { signal })
        : Promise.resolve(null),
    // `version` changes on every save, so the preview reloads with the new hours.
    [eventType?.id, version],
  );

  return (
    <section className="panel" aria-labelledby="preview">
      <h2 id="preview" className="panel__title">
        What guests see next week
      </h2>
      {!eventType ? (
        <p>
          <Link to="/event-types">Create an event type</Link> to see your free times here.
        </p>
      ) : slots.loading && !slots.data ? (
        <LoadingState label="Finding your free times…" />
      ) : slots.error ? (
        <ErrorState title="Can't show free times" error={slots.error} onRetry={slots.reload} />
      ) : !slots.data || slots.data.slots.length === 0 ? (
        <EmptyState title="No free times next week">Add hours above, or check your calendars aren't busy all week.</EmptyState>
      ) : (
        <>
          <p className="muted">
            {eventType.title}, in your time zone. Saved hours only.
          </p>
          <ul className="preview">
            {groupByDay(slots.data.slots.map((s) => s.start), user.timeZone).map(([day, times]) => (
              <li key={day}>
                <p className="preview__day">{day}</p>
                <p className="preview__times">
                  {times.slice(0, 8).join(', ')}
                  {times.length > 8 && ` and ${times.length - 8} more`}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function nextWeek(timeZone: string): { from: string; to: string } {
  // en-CA formats as YYYY-MM-DD; the host's own date, not the browser's.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  const to = new Date(`${today}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 7);
  return { from: today, to: to.toISOString().slice(0, 10) };
}

function groupByDay(starts: string[], timeZone: string): [string, string[]][] {
  const days = new Map<string, string[]>();
  for (const start of starts) {
    const day = formatDay(start, timeZone);
    days.set(day, [...(days.get(day) ?? []), formatTime(start, timeZone)]);
  }
  return [...days];
}
