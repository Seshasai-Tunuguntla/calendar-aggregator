import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BookingPageStatus } from '@calendar-aggregator/shared';
import { HOST, failing, mockApi, never, renderApp, signedInAs } from '../helpers/app.tsx';
import { booking, connection, eventType, status } from '../helpers/fixtures.ts';

const ready = (overrides: Record<string, unknown> = {}) => ({
  ...signedInAs(),
  'GET /api/booking-page/status': status(),
  'GET /api/connections': { connections: [connection()] },
  'GET /api/bookings': { bookings: [booking()], nextCursor: null },
  'GET /api/event-types': { eventTypes: [eventType()] },
  ...overrides,
});

const problem = (calendarProblem: BookingPageStatus['calendarProblem']) => ready({ 'GET /api/booking-page/status': status({ calendarProblem }) });

const reconnectHref = (email: string) => `/api/auth/google/start?${new URLSearchParams({ intent: 'connect', hint: email })}`;

describe('the dashboard', () => {
  it('shows a loading state, then the upcoming bookings in the host\'s time zone and the booking links', async () => {
    mockApi(ready());
    renderApp('/dashboard');
    expect(await screen.findByText('Loading your dashboard…')).toBeInTheDocument();
    // 08:30 UTC is 14:00 in India.
    expect(await screen.findByText('14:00–14:30')).toBeInTheDocument();
    expect(screen.getByText('Tue 13 Oct')).toBeInTheDocument();
    expect(screen.getByText('alex@example.com')).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/book/priya/30-min-call`)).toBeInTheDocument();
  });

  it('shows an error with a retry when it fails to load', async () => {
    let attempt = 0;
    mockApi(ready({ 'GET /api/bookings': () => (++attempt === 1 ? failing(500, 'Something went wrong (500). Please try again.')() : { bookings: [], nextCursor: null }) }));
    renderApp('/dashboard');
    expect(await screen.findByText("This didn't load")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No upcoming bookings')).toBeInTheDocument();
  });

  it('guides a new host: set hours, create an event type, nothing booked yet', async () => {
    mockApi(ready({ 'GET /api/booking-page/status': status({ activeEventTypes: 0, hasHours: false }), 'GET /api/bookings': { bookings: [], nextCursor: null }, 'GET /api/event-types': { eventTypes: [] } }));
    renderApp('/dashboard');
    expect(await screen.findByText('Set your working hours')).toBeInTheDocument();
    expect(screen.getByText('Create an event type')).toBeInTheDocument();
    expect(screen.getByText('No upcoming bookings')).toBeInTheDocument();
    expect(screen.getByText(/No event types are on yet/)).toBeInTheDocument();
  });

  describe("warns when the booking page isn't showing times because a busy calendar can't be checked", () => {
    it('temporary: says it usually fixes itself, and can check again', async () => {
      const calls = mockApi(problem({ kind: 'temporary', calendarName: null, accountEmail: null }));
      renderApp('/dashboard');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("Your booking page isn't showing times");
      expect(alert).toHaveTextContent("can't be checked right now, so guests see no times until it works again");
      await userEvent.click(within(alert).getByRole('button', { name: 'Check again' }));
      expect(calls.filter((c) => c.url === '/api/booking-page/status')).toHaveLength(2);
    });

    it('reconnect: names the account and links to reconnect it', async () => {
      mockApi(problem({ kind: 'reconnect', calendarName: null, accountEmail: 'priya@work.example' }));
      renderApp('/dashboard');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Google access for priya@work.example has expired or was removed');
      expect(within(alert).getByRole('link', { name: 'Reconnect Google' })).toHaveAttribute('href', reconnectHref('priya@work.example'));
    });

    it('unreadable: names the calendar and sends the host to untick it', async () => {
      mockApi(problem({ kind: 'unreadable', calendarName: 'Team', accountEmail: 'anil@work.example' }));
      renderApp('/dashboard');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("Team (anil@work.example) counts as busy but doesn't share its busy times");
      expect(within(alert).getByRole('link', { name: 'Go to calendars' })).toHaveAttribute('href', '/calendars');
    });
  });

  it('asks the host to reconnect an account whose Google access expired', async () => {
    mockApi(ready({ 'GET /api/connections': { connections: [connection(), connection({ id: '0190a5a4-0000-7000-8000-0000000000ff', accountEmail: 'priya@work.example', status: 'NEEDS_RECONNECT' })] } }));
    renderApp('/dashboard');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Reconnect Google');
    expect(alert).toHaveTextContent('Access to priya@work.example has expired or was removed');
    expect(within(alert).getByRole('link', { name: 'Reconnect' })).toHaveAttribute('href', reconnectHref('priya@work.example'));
  });

  it('lists bookings "cancelled, still on your calendar" separately from the upcoming ones', async () => {
    mockApi(
      ready({
        'GET /api/connections': { connections: [connection({ status: 'NEEDS_RECONNECT' })] },
        'GET /api/bookings': { bookings: [booking({ id: '0190a5a4-0000-7000-8000-000000000099', status: 'CANCELLED', stillOnCalendar: true, guestName: 'Sam Lee' }), booking()], nextCursor: null },
      }),
    );
    renderApp('/dashboard');
    const notice = (await screen.findAllByRole('alert')).find((a) => a.textContent?.includes('Cancelled, still on your calendar'));
    expect(notice).toHaveTextContent('Sam Lee cancelled Tue 13 Oct, 14:00 (30-min call).');
    expect(notice).toHaveTextContent("Google access had expired, so its event is still on your calendar. Reconnect and we'll remove it");
    const upcoming = screen.getByRole('heading', { name: 'Coming up' }).parentElement;
    expect(upcoming).not.toHaveTextContent('Sam Lee');
    expect(upcoming).toHaveTextContent('Alex Kim');
  });

  it('cancels a booking only after the host confirms, then reloads', async () => {
    let cancelled = false;
    const calls = mockApi(
      ready({
        'GET /api/bookings': () => ({ bookings: cancelled ? [] : [booking()], nextCursor: null }),
        [`POST /api/bookings/${booking().id}/cancel`]: () => {
          cancelled = true;
          return { booking: { ...booking(), status: 'CANCELLED' } };
        },
      }),
    );
    renderApp('/dashboard');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel…' }));
    expect(screen.getByText('Cancel it? Google will email Alex Kim.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    expect(await screen.findByText('No upcoming bookings')).toBeInTheDocument();
  });

  it("shows why a cancellation didn't go through", async () => {
    mockApi(ready({ [`POST /api/bookings/${booking().id}/cancel`]: failing(503, "We couldn't confirm the cancellation with Priya Sharma's calendar, so the booking is still on.") }));
    renderApp('/dashboard');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    expect(await screen.findByText(/so the booking is still on/)).toBeInTheDocument();
  });

  it('loads more bookings a page at a time', async () => {
    const calls = mockApi(
      ready({
        'GET /api/bookings': { bookings: [booking()], nextCursor: booking().id },
        [`GET /api/bookings?cursor=${booking().id}`]: { bookings: [booking({ id: '0190a5a4-0000-7000-8000-000000000021', guestName: 'Jordan Wu' })], nextCursor: null },
      }),
    );
    renderApp('/dashboard');
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Jordan Wu')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    expect(calls.map((c) => c.url)).toContain(`/api/bookings?cursor=${booking().id}`);
  });

  it('greets the demo host with what the demo is', async () => {
    mockApi(ready(signedInAs({ ...HOST, isDemo: true })));
    renderApp('/dashboard');
    expect(await screen.findByText("You're trying the demo host")).toBeInTheDocument();
  });

  it('keeps showing the loading state while a request is still running', async () => {
    mockApi(ready({ 'GET /api/bookings': never }));
    renderApp('/dashboard');
    expect(await screen.findByText('Loading your dashboard…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Coming up' })).not.toBeInTheDocument();
  });
});
