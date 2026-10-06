import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  calendarResponseSchema,
  calendarsResponseSchema,
  connectionsResponseSchema,
  disconnectResponseSchema,
  type Calendar,
  type Connection,
} from '@calendar-aggregator/shared';
import { apiGet, apiSend, errorMessage } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useSignedInUser } from '../auth/AuthContext.tsx';
import { Button, ButtonLink } from '../components/Button.tsx';
import { Notice } from '../components/Notice.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { EmptyState, ErrorState, LoadingState } from '../components/States.tsx';
import { googleStartUrl, signInErrorMessage } from '../signInErrors.ts';

export function CalendarsPage() {
  const user = useSignedInUser();
  const [params] = useSearchParams();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState<{ email: string; revokedAtGoogle: boolean } | null>(null);
  const page = useApi(async (signal) => {
    const [calendars, connections] = await Promise.all([
      apiGet('/api/calendars', calendarsResponseSchema, { signal }),
      apiGet('/api/connections', connectionsResponseSchema, { signal }),
    ]);
    return { ...calendars, connections: connections.connections };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await apiSend('POST', '/api/calendars/sync');
      page.reload();
    } catch (error) {
      setRefreshError(errorMessage(error));
    }
    setRefreshing(false);
  };

  const connectError = signInErrorMessage(params.get('error'));
  const header = (
    <PageHeader
      eyebrow="Calendars"
      title="Which calendars make you busy"
      actions={
        <>
          <Button busy={refreshing} onClick={refresh}>
            Refresh
          </Button>
          {!user.isDemo && (
            <ButtonLink variant="secondary" href={googleStartUrl({ intent: 'connect' })}>
              Connect another Google account
            </ButtonLink>
          )}
        </>
      }
    >
      <p>Ticked calendars block times on your booking page. Guests never see their names or events.</p>
    </PageHeader>
  );

  if (!page.data) {
    return (
      <>
        {header}
        {page.error ? <ErrorState error={page.error} onRetry={page.reload} /> : <LoadingState label="Loading your calendars…" />}
      </>
    );
  }

  const { calendars, connections, bookingCalendarId } = page.data;
  return (
    <>
      {header}
      <div className="stack">
        {params.get('connected') === '1' && <Notice tone="success" title="Account connected">Its calendars are listed below.</Notice>}
        {connectError && <Notice tone="danger" title="That account wasn't connected">{connectError}</Notice>}
        {refreshError && <Notice tone="danger" title="Couldn't refresh">{refreshError}</Notice>}
        {disconnected && (
          <Notice tone="success" title={`${disconnected.email} was disconnected`}>
            {!disconnected.revokedAtGoogle && "We couldn't reach Google to remove access; you can remove it at myaccount.google.com/permissions."}
          </Notice>
        )}
      </div>
      {connections.length === 0 ? (
        <EmptyState title="No accounts connected">Sign in with Google to list your calendars here.</EmptyState>
      ) : (
        connections.map((connection) => (
          <AccountSection
            key={connection.id}
            connection={connection}
            calendars={calendars.filter((c) => c.connectionId === connection.id)}
            bookingCalendarId={bookingCalendarId}
            onChanged={page.reload}
            onDisconnected={(revokedAtGoogle) => {
              setDisconnected({ email: connection.accountEmail, revokedAtGoogle });
              page.reload();
            }}
          />
        ))
      )}
    </>
  );
}

function AccountSection({
  connection,
  calendars,
  bookingCalendarId,
  onChanged,
  onDisconnected,
}: {
  connection: Connection;
  calendars: Calendar[];
  bookingCalendarId: string | null;
  onChanged: () => void;
  onDisconnected: (revokedAtGoogle: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = connection.status === 'NEEDS_RECONNECT';

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { revokedAtGoogle } = await apiSend('DELETE', `/api/connections/${connection.id}`, undefined, disconnectResponseSchema);
      onDisconnected(revokedAtGoogle);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <section className="account" aria-labelledby={`account-${connection.id}`}>
      <header className="account__header">
        <div>
          <h2 id={`account-${connection.id}`} className="section-title">
            {connection.accountEmail}
          </h2>
          <p className={expired ? 'status status--danger' : 'status status--ok'}>
            {connection.provider === 'DEMO' ? 'Demo calendars' : expired ? 'Access expired: reconnect to use these calendars' : 'Connected'}
          </p>
        </div>
        <div className="account__actions">
          {expired && (
            <ButtonLink variant="primary" href={googleStartUrl({ intent: 'connect', hint: connection.accountEmail })}>
              Reconnect Google
            </ButtonLink>
          )}
          {connection.canDisconnect &&
            (confirming ? (
              <div className="confirm" role="group" aria-label={`Disconnect ${connection.accountEmail}?`}>
                <p className="confirm__question">Disconnect? Its calendars stop counting, and access is revoked at Google.</p>
                <Button variant="danger" busy={busy} onClick={disconnect}>
                  Disconnect
                </Button>
                <Button variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
              </div>
            ) : (
              <Button variant="quiet" onClick={() => setConfirming(true)}>
                Disconnect…
              </Button>
            ))}
        </div>
      </header>
      {error && <Notice tone="danger">{error}</Notice>}
      {calendars.length === 0 ? (
        <EmptyState title="No calendars in this account">Use Refresh after adding calendars in Google Calendar.</EmptyState>
      ) : (
        <ul className="calendar-list">
          {calendars.map((calendar) => (
            <CalendarRow key={calendar.id} calendar={calendar} isBookingCalendar={calendar.id === bookingCalendarId} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

const ACCESS_TEXT: Record<Calendar['busyAccess'], string | null> = {
  READABLE: null,
  UNREADABLE: "Doesn't share busy times (holiday calendars are like this), so it can't block bookings.",
  UNKNOWN: "Can't check this calendar right now. Ticking it checks again.",
};

function CalendarRow({ calendar, isBookingCalendar, onChanged }: { calendar: Calendar; isBookingCalendar: boolean; onChanged: () => void }) {
  const [counts, setCounts] = useState(calendar.countsAsBusy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkboxId = `busy-${calendar.id}`;
  // An unreadable calendar can be unticked (if it was ticked before) but not ticked.
  const locked = calendar.busyAccess === 'UNREADABLE' && !counts;

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { calendar: saved } = await apiSend('PATCH', `/api/calendars/${calendar.id}`, { countsAsBusy: next }, calendarResponseSchema);
      setCounts(saved.countsAsBusy);
    } catch (caught) {
      setError(errorMessage(caught));
      onChanged();
    }
    setBusy(false);
  };

  const useForBookings = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiSend('PUT', '/api/calendars/booking-calendar', { calendarId: calendar.id });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  };

  const note = ACCESS_TEXT[calendar.busyAccess];
  return (
    <li className="calendar-row">
      <div className="checkbox">
        <input id={checkboxId} type="checkbox" checked={counts} disabled={busy || locked} onChange={(e) => void toggle(e.target.checked)} aria-describedby={note || error ? `${checkboxId}-note` : undefined} />
        <label htmlFor={checkboxId}>
          <span className="calendar-row__name">{calendar.name}</span>
          {calendar.isPrimary && <span className="tag">Primary</span>}
          <span className="sr-only"> counts as busy</span>
        </label>
      </div>
      <div className="calendar-row__meta" id={`${checkboxId}-note`}>
        {note && <p className={calendar.busyAccess === 'UNREADABLE' ? 'muted' : 'status status--warning'}>{note}</p>}
        {error && <p className="field__error">{error}</p>}
      </div>
      <div className="calendar-row__booking">
        {calendar.canCreateEvents &&
          (isBookingCalendar ? (
            <p className="status status--ok">New bookings go here</p>
          ) : (
            <Button variant="quiet" disabled={busy} onClick={useForBookings}>
              Put bookings here
            </Button>
          ))}
      </div>
    </li>
  );
}
