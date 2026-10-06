import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestBooking, Slot } from '@calendar-aggregator/shared';
import { failing, mockApi, never, renderApp, type Call } from '../helpers/app.tsx';

const PAGE = '/book/priya/30-min-call';
const INFO = {
  host: { name: 'Priya Sharma', timeZone: 'Asia/Kolkata', isDemo: false },
  eventType: { slug: '30-min-call', title: '30-min call', description: 'Talk it through.', durationMinutes: 30 },
};
const slot = (iso: string): Slot => ({ start: new Date(iso).toISOString(), end: new Date(Date.parse(iso) + 30 * 60_000).toISOString() });
// In New York (EDT): Tue 13 Oct 10:00 and 10:30, Thu 15 Oct 14:00. Nothing on the 14th.
const SLOTS = [slot('2026-10-13T14:00:00Z'), slot('2026-10-13T14:30:00Z'), slot('2026-10-15T18:00:00Z')];
const TOKEN = 'T'.repeat(43);

const booked = (start: Slot): GuestBooking => ({
  status: 'CONFIRMED',
  start: start.start,
  end: start.end,
  guestName: 'Alex Kim',
  guestEmail: 'alex@example.com',
  guestTimeZone: 'America/New_York',
  host: { name: 'Priya Sharma', timeZone: 'Asia/Kolkata', isDemo: false },
  eventType: { title: '30-min call', durationMinutes: 30, bookingPath: PAGE },
  canChange: true,
});

const demo = (b: GuestBooking): GuestBooking => ({ ...b, host: { ...b.host, isDemo: true } });
const slotsCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith(`/api/public${PAGE}/slots`));
const queryOf = (call: Call | undefined) => Object.fromEntries(new URL(call?.url ?? '', 'http://x').searchParams);

beforeEach(() => {
  // The guest's browser is in New York.
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone: 'America/New_York' };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const ready = (overrides: Record<string, unknown> = {}) => ({
  [`GET /api/public${PAGE}`]: INFO,
  [`GET /api/public${PAGE}/slots`]: { slots: SLOTS },
  ...overrides,
});

async function fillAndBook(name = 'Alex Kim', email = 'alex@example.com') {
  await userEvent.type(screen.getByLabelText('Your name'), name);
  await userEvent.type(screen.getByLabelText('Email for the invitation'), email);
  await userEvent.click(screen.getByRole('button', { name: 'Book this time' }));
}

describe('the booking page', () => {
  it("detects the guest's time zone, and only offers days that have times", async () => {
    const calls = mockApi(ready());
    renderApp(PAGE);
    expect(await screen.findByRole('heading', { name: '30-min call' })).toBeInTheDocument();
    expect(await screen.findByText(/Times are in/)).toHaveTextContent('New York (GMT-4)');
    expect(queryOf(slotsCalls(calls)[0])).toMatchObject({ tz: 'America/New_York' });

    const strip = await screen.findByRole('region', { name: 'Days with free times' });
    const days = within(strip).getAllByRole('button').filter((b) => b.classList.contains('day-button'));
    expect(days).toHaveLength(2);
    expect(days[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button').filter((b) => b.classList.contains('slot')).map((b) => b.textContent?.replace(/\s/g, ' '))).toEqual(['10:00 AM', '10:30 AM']);
    // Guests' pages never ask who is signed in.
    expect(calls.some((c) => c.url === '/api/auth/me')).toBe(false);
  });

  it('lets the guest change the time zone, and asks for times in it', async () => {
    const calls = mockApi(ready());
    renderApp(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Change time zone' }));
    await userEvent.selectOptions(screen.getByLabelText('Your time zone'), 'Europe/London');
    await waitFor(() => expect(queryOf(slotsCalls(calls).at(-1))).toMatchObject({ tz: 'Europe/London' }));
    expect(await screen.findByText(/Times are in/)).toHaveTextContent('London');
    expect(screen.getAllByRole('button').filter((b) => b.classList.contains('slot'))[0]?.textContent?.replace(/\s/g, ' ')).toBe('3:00 PM');
  });

  it("books a time, then confirms it in the guest's zone with the manage link and next steps", async () => {
    const calls = mockApi(ready({ [`POST /api/public${PAGE}/bookings`]: () => Response.json({ booking: booked(SLOTS[1] as Slot), manageToken: TOKEN, managePath: `/booking/${TOKEN}` }, { status: 201 }) }));
    renderApp(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: /^10:30\sAM$/ }));
    expect(screen.getByText(/That's 8:00\sPM for Priya Sharma\./)).toBeInTheDocument();
    await fillAndBook();

    expect(await screen.findByRole('heading', { name: 'You’re booked with Priya Sharma'.replace('’', "'") })).toBeInTheDocument();
    expect(screen.getByText(/10:30\sAM–11:00\sAM, New York \(GMT-4\)/)).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/booking/${TOKEN}`)).toBeInTheDocument();
    expect(screen.getByText(/Google Calendar emails an invitation to alex@example.com/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ start: SLOTS[1]?.start, guestName: 'Alex Kim', guestEmail: 'alex@example.com', guestTimeZone: 'America/New_York' });
  });

  it('on "That time was just taken": says so, refreshes the times and keeps what the guest typed', async () => {
    let taken = false;
    const calls = mockApi(
      ready({
        [`GET /api/public${PAGE}/slots`]: () => ({ slots: taken ? SLOTS.slice(1) : SLOTS }),
        [`POST /api/public${PAGE}/bookings`]: () => {
          taken = true;
          return Response.json({ error: 'That time was just taken. Please pick another.' }, { status: 409 });
        },
      }),
    );
    renderApp(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: /^10:00\sAM$/ }));
    await fillAndBook();

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('Please pick another time');
    // The form has gone, so the guest is put on the message rather than lost at the top of the page.
    expect(notice.parentElement).toHaveFocus();
    expect(notice).toHaveTextContent('That time was just taken. Please pick another. The times below are up to date.');
    await waitFor(() => expect(screen.queryByRole('button', { name: /^10:00\sAM$/ })).not.toBeInTheDocument());
    expect(slotsCalls(calls)).toHaveLength(2);
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^10:30\sAM$/ }));
    expect(screen.getByLabelText('Your name')).toHaveValue('Alex Kim');
    expect(screen.getByLabelText('Email for the invitation')).toHaveValue('alex@example.com');
    expect(screen.queryByText('Please pick another time')).not.toBeInTheDocument();
  });

  it("shows why booking failed for another reason, and stays on the form", async () => {
    mockApi(ready({ [`POST /api/public${PAGE}/bookings`]: failing(503, "We couldn't add this to Priya Sharma's calendar, so nothing was booked. Please try again in a few minutes.") }));
    renderApp(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: /^10:00\sAM$/ }));
    await fillAndBook();
    expect(await screen.findByText(/so nothing was booked/)).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toHaveValue('Alex Kim');
  });

  it('says when there are no free times, and offers later dates', async () => {
    mockApi(ready({ [`GET /api/public${PAGE}/slots`]: { slots: [] } }));
    renderApp(PAGE);
    expect(await screen.findByText('No free times in the next six weeks')).toBeInTheDocument();
  });

  it("says when times can't be shown right now, with a retry", async () => {
    let attempt = 0;
    mockApi(ready({ [`GET /api/public${PAGE}/slots`]: () => (++attempt === 1 ? failing(503, "This booking page can't show times right now. Please try again in a few minutes.")() : { slots: SLOTS }) }));
    renderApp(PAGE);
    expect(await screen.findByText("Can't show free times")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^10:00\sAM$/ })).toBeInTheDocument();
  });

  it('shows a loading state', async () => {
    mockApi(ready({ [`GET /api/public${PAGE}`]: never }));
    renderApp(PAGE);
    expect(await screen.findByText('Loading the booking page…')).toBeInTheDocument();
  });

  it('shows an error state with a retry when the page fails to load', async () => {
    let attempt = 0;
    mockApi(ready({ [`GET /api/public${PAGE}`]: () => (++attempt === 1 ? failing()() : INFO) }));
    renderApp(PAGE);
    expect(await screen.findByText("This didn't load")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: '30-min call' })).toBeInTheDocument();
  });

  it("shows a not-found page for a booking link that doesn't exist", async () => {
    mockApi({ 'GET /api/public/book/nobody/call': failing(404, "This booking page doesn't exist") });
    renderApp('/book/nobody/call');
    expect(await screen.findByRole('heading', { name: "This booking page doesn't exist" })).toBeInTheDocument();
  });

  it('tells demo guests that no invitation is sent', async () => {
    mockApi(ready({ [`GET /api/public${PAGE}`]: { ...INFO, host: { ...INFO.host, isDemo: true } }, [`POST /api/public${PAGE}/bookings`]: () => Response.json({ booking: demo(booked(SLOTS[0] as Slot)), manageToken: TOKEN, managePath: `/booking/${TOKEN}` }, { status: 201 }) }));
    renderApp(PAGE);
    expect(await screen.findByText('This is the demo')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /^10:00\sAM$/ }));
    await fillAndBook();
    expect(await screen.findByText(/This is the demo, so no invitation is sent/)).toBeInTheDocument();
  });
});
