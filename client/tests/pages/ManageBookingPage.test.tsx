import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { GuestBooking } from '@calendar-aggregator/shared';
import { failing, mockApi, never, renderApp } from '../helpers/app.tsx';

const TOKEN = 'M'.repeat(43);
const API = `/api/public/bookings/${TOKEN}`;
const SLOTS_API = '/api/public/book/priya/30-min-call/slots';
const BOOKING: GuestBooking = {
  status: 'CONFIRMED',
  start: '2026-10-13T14:00:00.000Z',
  end: '2026-10-13T14:30:00.000Z',
  guestName: 'Alex Kim',
  guestEmail: 'alex@example.com',
  guestTimeZone: 'America/New_York',
  host: { name: 'Priya Sharma', timeZone: 'Asia/Kolkata', isDemo: false },
  eventType: { title: '30-min call', durationMinutes: 30, bookingPath: '/book/priya/30-min-call' },
  canChange: true,
};
const NEW_TIME = { start: '2026-10-15T18:00:00.000Z', end: '2026-10-15T18:30:00.000Z' };
const meta = (name: string) => document.head.querySelector(`meta[name="${name}"]`)?.getAttribute('content');

describe('the manage page', () => {
  it("keeps its secret link private: no-referrer and noindex while it's open, gone after", async () => {
    mockApi({ [`GET ${API}`]: { booking: BOOKING } });
    const router = renderApp(`/booking/${TOKEN}`);
    await screen.findByText('Alex Kim');
    expect(meta('referrer')).toBe('no-referrer');
    expect(meta('robots')).toBe('noindex, nofollow');
    await router.navigate('/login');
    await waitFor(() => expect(meta('referrer')).toBeUndefined());
    expect(meta('robots')).toBeUndefined();
  });

  it("shows the booking in the zone the guest booked in, which they can change", async () => {
    mockApi({ [`GET ${API}`]: { booking: BOOKING } });
    renderApp(`/booking/${TOKEN}`);
    expect(await screen.findByText(/10:00\sAM–10:30\sAM, New York \(GMT-4\)/)).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Change time zone' }));
    expect(screen.getByLabelText('Your time zone')).toHaveFocus();
    // Listed by today's name, whatever the browser calls it.
    await userEvent.selectOptions(screen.getByLabelText('Your time zone'), screen.getByRole('option', { name: 'Asia/Kolkata' }));
    expect(await screen.findByText(/7:30\sPM–8:00\sPM, Kolkata \(GMT\+5:30\)/)).toBeInTheDocument();
  });

  it('cancels only after the guest confirms', async () => {
    const calls = mockApi({ [`GET ${API}`]: { booking: BOOKING }, [`POST ${API}/cancel`]: { booking: { ...BOOKING, status: 'CANCELLED', canChange: false } } });
    renderApp(`/booking/${TOKEN}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel booking' }));
    expect(screen.getByRole('heading', { name: 'Cancel this booking?' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    // Back on the button that opened it.
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel booking' }).at(-1) as HTMLElement);
    expect((await screen.findByText("Cancelled. Priya Sharma's calendar has been updated.")).closest('.focus-target')).toHaveFocus();
    expect(screen.getByRole('link', { name: 'Book a new time' })).toHaveAttribute('href', '/book/priya/30-min-call');
  });

  it('reschedules to a new time', async () => {
    const calls = mockApi({
      [`GET ${API}`]: { booking: BOOKING },
      [`GET ${SLOTS_API}`]: { slots: [NEW_TIME] },
      [`POST ${API}/reschedule`]: { booking: { ...BOOKING, ...NEW_TIME } },
    });
    renderApp(`/booking/${TOKEN}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));
    expect(screen.getByRole('heading', { name: 'Pick a new time' })).toHaveFocus();
    await userEvent.click(await screen.findByRole('button', { name: /^2:00\sPM$/ }));
    // The button names the day as well as the time: the guest may have paged to another week.
    await userEvent.click(screen.getByRole('button', { name: /^Move to Thursday,? (15 October|October 15), 2:00\sPM$/ }));
    expect((await screen.findByText('Moved. Google Calendar emails you the new time.')).closest('.focus-target')).toHaveFocus();
    expect(screen.getByText(/2:00\sPM–2:30\sPM/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ start: NEW_TIME.start });
  });

  it('"Keep my current time" closes the picker and returns to the Reschedule button', async () => {
    mockApi({ [`GET ${API}`]: { booking: BOOKING }, [`GET ${SLOTS_API}`]: { slots: [NEW_TIME] } });
    renderApp(`/booking/${TOKEN}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep my current time' }));
    expect(screen.queryByRole('heading', { name: 'Pick a new time' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reschedule' })).toHaveFocus();
  });

  it('on "just taken" while rescheduling: says so and refreshes the times', async () => {
    const calls = mockApi({
      [`GET ${API}`]: { booking: BOOKING },
      [`GET ${SLOTS_API}`]: { slots: [NEW_TIME] },
      [`POST ${API}/reschedule`]: failing(409, 'That time was just taken. Please pick another.'),
    });
    renderApp(`/booking/${TOKEN}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));
    await userEvent.click(await screen.findByRole('button', { name: /^2:00\sPM$/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Move to/ }));
    const message = await screen.findByText('That time was just taken. Please pick another. The times below are up to date.');
    expect(message.closest('.focus-target')).toHaveFocus();
    expect(calls.filter((c) => c.url.startsWith(SLOTS_API))).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Move here' })).toBeDisabled();
  });

  it("doesn't promise emails for the demo host, which sends none", async () => {
    const demo = { ...BOOKING, host: { ...BOOKING.host, isDemo: true } };
    mockApi({ [`GET ${API}`]: { booking: demo }, [`GET ${SLOTS_API}`]: { slots: [NEW_TIME] }, [`POST ${API}/reschedule`]: { booking: { ...demo, ...NEW_TIME } } });
    renderApp(`/booking/${TOKEN}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel booking' }));
    expect(screen.getByText("Priya Sharma's calendar is updated.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    await userEvent.click(await screen.findByRole('button', { name: /^2:00\sPM$/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Move to/ }));
    expect(await screen.findByText('Moved.')).toBeInTheDocument();
    expect(screen.queryByText(/emails/)).not.toBeInTheDocument();
  });

  it("shows a started meeting as no longer changeable", async () => {
    mockApi({ [`GET ${API}`]: { booking: { ...BOOKING, canChange: false } } });
    renderApp(`/booking/${TOKEN}`);
    expect(await screen.findByText(/the meeting has started, so it can no longer be changed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reschedule' })).not.toBeInTheDocument();
  });

  it("explains a link that doesn't work", async () => {
    mockApi({ [`GET ${API}`]: failing(404, 'This booking link is not valid. Check that you copied all of it.') });
    renderApp(`/booking/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: "This link doesn't work" })).toBeInTheDocument();
    expect(screen.getByText(/Check that you copied all of it/)).toBeInTheDocument();
  });

  it('shows a loading state', async () => {
    mockApi({ [`GET ${API}`]: never });
    renderApp(`/booking/${TOKEN}`);
    expect(await screen.findByText('Loading your booking…')).toBeInTheDocument();
  });

  it('shows an error state with a retry when the booking fails to load', async () => {
    let attempt = 0;
    mockApi({ [`GET ${API}`]: () => (++attempt === 1 ? failing()() : { booking: BOOKING }) });
    renderApp(`/booking/${TOKEN}`);
    expect(await screen.findByText("This didn't load")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Alex Kim')).toBeInTheDocument();
  });
});
