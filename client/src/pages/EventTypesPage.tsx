import { useState } from 'react';
import {
  createEventTypeRequestSchema,
  eventTypeResponseSchema,
  eventTypesResponseSchema,
  updateEventTypeRequestSchema,
  type EventType,
} from '@calendar-aggregator/shared';
import { apiGet, apiSend, errorMessage } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { Button } from '../components/Button.tsx';
import { CopyButton } from '../components/CopyButton.tsx';
import { Field } from '../components/Field.tsx';
import { Notice } from '../components/Notice.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { EmptyState, ErrorState, LoadingState } from '../components/States.tsx';
import { bookingUrl, formatDuration } from '../format.ts';

const DURATIONS = [15, 20, 30, 45, 60, 90, 120];
const STEPS = [5, 10, 15, 20, 30, 60];

const withValue = (options: number[], value: number) => (options.includes(value) ? options : [...options, value].toSorted((a, b) => a - b));

// "30-min call!" -> "30-min-call"
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

interface Draft {
  title: string;
  slug: string;
  description: string;
  durationMinutes: number;
  slotStepMinutes: number;
}

const NEW: Draft = { title: '', slug: '', description: '', durationMinutes: 30, slotStepMinutes: 30 };

export function EventTypesPage() {
  const page = useApi((signal) => apiGet('/api/event-types', eventTypesResponseSchema, { signal }), []);
  const [creating, setCreating] = useState(false);

  const header = (
    <PageHeader
      eyebrow="Event types"
      title="What guests can book"
      actions={
        !creating && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            New event type
          </Button>
        )
      }
    >
      <p>Each one has its own length and its own link.</p>
    </PageHeader>
  );
  if (!page.data) {
    return (
      <>
        {header}
        {page.error ? <ErrorState error={page.error} onRetry={page.reload} /> : <LoadingState label="Loading your event types…" />}
      </>
    );
  }

  const { eventTypes } = page.data;
  return (
    <>
      {header}
      {creating && (
        <EventTypeForm
          title="New event type"
          initial={NEW}
          submitLabel="Create"
          onCancel={() => setCreating(false)}
          onSubmit={async (draft) => {
            await apiSend('POST', '/api/event-types', createEventTypeRequestSchema.parse(draft), eventTypeResponseSchema);
            setCreating(false);
            page.reload();
          }}
        />
      )}
      {eventTypes.length === 0 && !creating ? (
        <EmptyState
          title="No event types yet"
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create your first
            </Button>
          }
        >
          A 30-minute call is a good start.
        </EmptyState>
      ) : (
        <ul className="event-type-list">
          {eventTypes.map((eventType) => (
            <EventTypeRow key={eventType.id} eventType={eventType} onChanged={page.reload} />
          ))}
        </ul>
      )}
    </>
  );
}

function EventTypeRow({ eventType, onChanged }: { eventType: EventType; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  };

  if (editing) {
    return (
      <li>
        <EventTypeForm
          title={`Edit ${eventType.title}`}
          initial={eventType}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (draft) => {
            await apiSend('PATCH', `/api/event-types/${eventType.id}`, updateEventTypeRequestSchema.parse(draft), eventTypeResponseSchema);
            setEditing(false);
            onChanged();
          }}
        />
      </li>
    );
  }

  const toggleId = `active-${eventType.id}`;
  return (
    <li className={`event-type${eventType.active ? '' : ' event-type--off'}`}>
      <div className="event-type__main">
        <h2 className="event-type__title">{eventType.title}</h2>
        <p className="muted">
          {formatDuration(eventType.durationMinutes)} · start times every {formatDuration(eventType.slotStepMinutes)}
        </p>
        {eventType.description && <p>{eventType.description}</p>}
        <p className="event-type__link">
          <code>{bookingUrl(eventType.bookingPath)}</code>
          {eventType.active && <CopyButton text={bookingUrl(eventType.bookingPath)} />}
        </p>
        {error && <p className="field__error">{error}</p>}
      </div>
      <div className="event-type__actions">
        <div className="checkbox">
          <input
            id={toggleId}
            type="checkbox"
            checked={eventType.active}
            disabled={busy}
            onChange={(e) => void run(() => apiSend('PATCH', `/api/event-types/${eventType.id}`, { active: e.target.checked }))}
          />
          <label htmlFor={toggleId}>{eventType.active ? 'Bookable' : 'Turned off'}</label>
        </div>
        <Button variant="quiet" onClick={() => setEditing(true)}>
          Edit
        </Button>
        {confirming ? (
          <div className="confirm" role="group" aria-label={`Delete ${eventType.title}?`}>
            <p className="confirm__question">Delete it? Its link stops working.</p>
            <Button variant="danger" busy={busy} onClick={() => void run(() => apiSend('DELETE', `/api/event-types/${eventType.id}`))}>
              Delete
            </Button>
            <Button variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        ) : (
          <Button variant="quiet" onClick={() => setConfirming(true)}>
            Delete…
          </Button>
        )}
      </div>
    </li>
  );
}

function EventTypeForm({
  title,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: Draft;
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    title: initial.title,
    slug: initial.slug,
    description: initial.description,
    durationMinutes: initial.durationMinutes,
    slotStepMinutes: initial.slotStepMinutes,
  });
  // The link follows the title until the host edits the link itself.
  const [slugEdited, setSlugEdited] = useState(initial.slug !== '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = async () => {
    setError(null);
    const checked = createEventTypeRequestSchema.safeParse(draft);
    if (!checked.success) {
      setError(checked.error.issues[0]?.message ?? 'Check the form');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(draft);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <form
      className="panel event-type-form"
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="panel__title">{title}</h2>
      <div className="settings-grid">
        <Field label="Title" hint="Guests see this, e.g. “30-min call”.">
          {(control) => (
            <input
              {...control}
              className="input"
              value={draft.title}
              maxLength={100}
              onChange={(e) => {
                set('title', e.target.value);
                if (!slugEdited) set('slug', slugify(e.target.value));
              }}
            />
          )}
        </Field>
        <Field label="Link" hint={`Lowercase letters, digits and hyphens: …/${draft.slug || 'your-link'}`}>
          {(control) => (
            <input
              {...control}
              className="input"
              value={draft.slug}
              maxLength={60}
              onChange={(e) => {
                setSlugEdited(true);
                set('slug', e.target.value.toLowerCase());
              }}
            />
          )}
        </Field>
        <Field label="Length">
          {(control) => (
            <select {...control} className="select" value={draft.durationMinutes} onChange={(e) => set('durationMinutes', Number(e.target.value))}>
              {withValue(DURATIONS, draft.durationMinutes).map((m) => (
                <option key={m} value={m}>
                  {formatDuration(m)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Start times every" hint="How far apart the offered times are.">
          {(control) => (
            <select {...control} className="select" value={draft.slotStepMinutes} onChange={(e) => set('slotStepMinutes', Number(e.target.value))}>
              {withValue(STEPS, draft.slotStepMinutes).map((m) => (
                <option key={m} value={m}>
                  {formatDuration(m)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field label="Description (optional)">
        {(control) => <textarea {...control} className="input textarea" rows={3} maxLength={1000} value={draft.description} onChange={(e) => set('description', e.target.value)} />}
      </Field>
      {error && (
        <Notice tone="danger">
          <p>{error}</p>
        </Notice>
      )}
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {submitLabel}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
