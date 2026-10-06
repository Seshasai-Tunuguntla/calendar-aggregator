import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HOST, failing, mockApi, never, renderApp, signedInAs } from '../helpers/app.tsx';
import { calendar, connection, id } from '../helpers/fixtures.ts';

const PRIMARY = calendar();
const HOLIDAYS = calendar({ id: id(41), name: 'Holidays in India', isPrimary: false, countsAsBusy: false, canCreateEvents: false, busyAccess: 'UNREADABLE' });
const TEAM = calendar({ id: id(42), name: 'Team', isPrimary: false, countsAsBusy: false, canCreateEvents: false, busyAccess: 'UNKNOWN' });
const SIDE = calendar({ id: id(43), name: 'Side project', isPrimary: false, countsAsBusy: true, canCreateEvents: true });

const ready = (overrides: Record<string, unknown> = {}) => ({
  ...signedInAs(),
  'GET /api/calendars': { calendars: [PRIMARY, HOLIDAYS, TEAM, SIDE], bookingCalendarId: PRIMARY.id },
  'GET /api/connections': { connections: [connection()] },
  ...overrides,
});

const row = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement;

describe('the calendars page', () => {
  it('shows each calendar with whether it counts as busy, can be read, and takes bookings', async () => {
    mockApi(ready());
    renderApp('/calendars');
    expect(within(await row('Priya')).getByRole('checkbox')).toBeChecked();
    expect(within(await row('Priya')).getByText('New bookings go here')).toBeInTheDocument();
    // An unreadable calendar can't be ticked, and says why.
    expect(within(await row('Holidays in India')).getByRole('checkbox')).toBeDisabled();
    expect(await row('Holidays in India')).toHaveTextContent("Doesn't share busy times (holiday calendars are like this)");
    // Temporarily unknown: "can't check right now", still tickable (ticking checks again).
    expect(within(await row('Team')).getByRole('checkbox')).toBeEnabled();
    expect(await row('Team')).toHaveTextContent("Can't check this calendar right now. Ticking it checks again.");
    expect(within(await row('Side project')).getByRole('button', { name: 'Put bookings here' })).toBeInTheDocument();
  });

  it('ticks a calendar, and shows the reason when the server refuses', async () => {
    const calls = mockApi(ready({ [`PATCH /api/calendars/${TEAM.id}`]: failing(503, "Can't check your calendar right now. Try again in a minute.") }));
    renderApp('/calendars');
    await userEvent.click(within(await row('Team')).getByRole('checkbox'));
    expect(await screen.findByText("Can't check your calendar right now. Try again in a minute.")).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ countsAsBusy: true });
    expect(within(await row('Team')).getByRole('checkbox')).not.toBeChecked();
  });

  it('unticks a calendar', async () => {
    const calls = mockApi(ready({ [`PATCH /api/calendars/${PRIMARY.id}`]: { calendar: { ...PRIMARY, countsAsBusy: false } } }));
    renderApp('/calendars');
    await userEvent.click(within(await row('Priya')).getByRole('checkbox'));
    expect(within(await row('Priya')).getByRole('checkbox')).not.toBeChecked();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ countsAsBusy: false });
  });

  it('chooses where bookings go', async () => {
    const calls = mockApi(ready({ 'PUT /api/calendars/booking-calendar': { calendars: [PRIMARY, SIDE], bookingCalendarId: SIDE.id } }));
    renderApp('/calendars');
    await userEvent.click(within(await row('Side project')).getByRole('button', { name: 'Put bookings here' }));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ calendarId: SIDE.id });
  });

  it('refreshes from Google', async () => {
    const calls = mockApi(ready({ 'POST /api/calendars/sync': { calendars: [], bookingCalendarId: null } }));
    renderApp('/calendars');
    await userEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(calls.filter((c) => c.url === '/api/calendars')).toHaveLength(2);
  });

  it('offers "Reconnect Google" for an account whose access expired', async () => {
    mockApi(ready({ 'GET /api/connections': { connections: [connection({ status: 'NEEDS_RECONNECT' })] } }));
    renderApp('/calendars');
    expect(await screen.findByText('Access expired: reconnect to use these calendars')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reconnect Google' })).toHaveAttribute(
      'href',
      `/api/auth/google/start?${new URLSearchParams({ intent: 'connect', hint: 'priya@example.com' })}`,
    );
  });

  it('disconnects an account after confirmation and says whether Google access was revoked', async () => {
    const work = connection({ id: id(11), accountEmail: 'priya@work.example', canDisconnect: true });
    mockApi(ready({ 'GET /api/connections': { connections: [connection(), work] }, [`DELETE /api/connections/${work.id}`]: { revokedAtGoogle: false } }));
    renderApp('/calendars');
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('priya@work.example was disconnected')).toBeInTheDocument();
    expect(screen.getByText(/We couldn't reach Google to remove access/)).toBeInTheDocument();
  });

  it('says the account was connected, or why it wasn\'t, after returning from Google', async () => {
    mockApi(ready());
    renderApp('/calendars?connected=1');
    expect(await screen.findByText('Account connected')).toBeInTheDocument();
  });

  it('hides "Connect another Google account" for the demo host', async () => {
    mockApi(ready(signedInAs({ ...HOST, isDemo: true })));
    renderApp('/calendars');
    await screen.findByText('Priya');
    expect(screen.queryByRole('link', { name: 'Connect another Google account' })).not.toBeInTheDocument();
  });

  it('shows a loading state while the calendars load', async () => {
    mockApi(ready({ 'GET /api/calendars': never }));
    renderApp('/calendars');
    expect(await screen.findByText('Loading your calendars…')).toBeInTheDocument();
  });

  it('shows an error state when the calendars fail to load', async () => {
    mockApi(ready({ 'GET /api/calendars': failing() }));
    renderApp('/calendars');
    expect(await screen.findByText("This didn't load")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows an empty state with no accounts', async () => {
    mockApi(ready({ 'GET /api/calendars': { calendars: [], bookingCalendarId: null }, 'GET /api/connections': { connections: [] } }));
    renderApp('/calendars');
    expect(await screen.findByText('No accounts connected')).toBeInTheDocument();
  });
});
