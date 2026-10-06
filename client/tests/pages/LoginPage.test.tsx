import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HOST, mockApi, renderApp, signedInAs, signedOut } from '../helpers/app.tsx';

describe('the sign-in page', () => {
  it('offers Google sign-in with the browser\'s time zone, and the demo', async () => {
    mockApi(signedOut);
    renderApp('/login');
    const google = await screen.findByRole('link', { name: 'Sign in with Google' });
    const url = new URL(google.getAttribute('href') ?? '', 'http://localhost');
    expect(url.pathname).toBe('/api/auth/google/start');
    expect(url.searchParams.get('tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(screen.getByRole('button', { name: 'Try as host' })).toBeEnabled();
  });

  it('turns an error code from the Google callback into a message a person can act on', async () => {
    mockApi(signedOut);
    renderApp('/login?error=calendar_permission_missing');
    expect(await screen.findByRole('alert')).toHaveTextContent("Calendar access is needed: on Google's page, keep all the calendar boxes ticked.");
  });

  it('shows a generic message for an unknown code, never the code itself', async () => {
    mockApi(signedOut);
    renderApp('/login?error=<script>');
    expect(await screen.findByRole('alert')).toHaveTextContent('Google had a problem completing that.');
    expect(screen.queryByText(/script/)).not.toBeInTheDocument();
  });

  it('"Try as host" signs into the demo and opens the dashboard', async () => {
    let signedIn = false;
    const calls = mockApi({
      'GET /api/auth/me': () => (signedIn ? { user: { ...HOST, isDemo: true } } : Response.json({ error: 'Not signed in' }, { status: 401 })),
      'POST /api/auth/demo': () => {
        signedIn = true;
        return { user: { ...HOST, isDemo: true } };
      },
      'GET /api/booking-page/status': { activeEventTypes: 0, hasHours: true, calendarProblem: null },
      'GET /api/connections': { connections: [] },
      'GET /api/bookings': { bookings: [], nextCursor: null },
      'GET /api/event-types': { eventTypes: [] },
    });
    const router = renderApp('/login');
    await userEvent.click(await screen.findByRole('button', { name: 'Try as host' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
    expect(await screen.findByText("You're trying the demo host")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/auth/demo']);
  });

  it('shows why the demo sign-in failed', async () => {
    mockApi({ ...signedOut, 'POST /api/auth/demo': () => Response.json({ error: 'Too many requests, please try again later' }, { status: 429 }) });
    renderApp('/login');
    await userEvent.click(await screen.findByRole('button', { name: 'Try as host' }));
    expect(await screen.findByText('Too many requests, please try again later')).toBeInTheDocument();
  });

  it('sends someone already signed in to the dashboard', async () => {
    mockApi({ ...signedInAs(), 'GET /api/booking-page/status': { activeEventTypes: 1, hasHours: true, calendarProblem: null }, 'GET /api/connections': { connections: [] }, 'GET /api/bookings': { bookings: [], nextCursor: null }, 'GET /api/event-types': { eventTypes: [] } });
    const router = renderApp('/login');
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
  });
});

describe('the host pages', () => {
  it('send signed-out visitors to the sign-in page', async () => {
    mockApi(signedOut);
    const router = renderApp('/calendars');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('say so, with a retry, when the sign-in check itself fails', async () => {
    let attempts = 0;
    mockApi({
      'GET /api/auth/me': () => (++attempts === 1 ? Response.json({ error: 'down' }, { status: 503 }) : { user: HOST }),
      'GET /api/booking-page/status': { activeEventTypes: 1, hasHours: true, calendarProblem: null },
      'GET /api/connections': { connections: [] },
      'GET /api/bookings': { bookings: [], nextCursor: null },
      'GET /api/event-types': { eventTypes: [] },
    });
    renderApp('/dashboard');
    expect(await screen.findByText("We couldn't check who's signed in")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: /Priya$/ })).toBeInTheDocument();
  });

  it('go to the sign-in page when the session ends mid-visit (a 401 from any call)', async () => {
    mockApi({ ...signedInAs(), 'GET /api/calendars': () => Response.json({ error: 'Not signed in' }, { status: 401 }), 'GET /api/connections': { connections: [] } });
    const router = renderApp('/calendars');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('show a not-found page for unknown addresses', async () => {
    mockApi(signedOut);
    renderApp('/nowhere');
    expect(await screen.findByRole('heading', { name: "There's nothing here" })).toBeInTheDocument();
  });
});
