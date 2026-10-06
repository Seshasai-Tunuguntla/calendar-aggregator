import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Availability } from '@calendar-aggregator/shared';
import { failing, mockApi, never, renderApp, signedInAs } from '../helpers/app.tsx';
import { eventType } from '../helpers/fixtures.ts';

const AVAILABILITY: Availability = {
  timeZone: 'Asia/Kolkata',
  rules: [{ weekday: 1, startMinute: 540, endMinute: 720 }],
  settings: { bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 240, horizonDays: 30, maxPerDay: null },
};

const ready = (overrides: Record<string, unknown> = {}) => ({
  ...signedInAs(),
  'GET /api/availability': AVAILABILITY,
  'GET /api/event-types': { eventTypes: [eventType()] },
  'GET /api/public/book/priya/30-min-call/slots': { slots: [{ start: '2026-10-12T03:30:00.000Z', end: '2026-10-12T04:00:00.000Z' }] },
  ...overrides,
});

describe('the availability page', () => {
  it('shows the weekly hours, settings and what guests see next week', async () => {
    mockApi(ready());
    renderApp('/availability');
    expect(await screen.findByLabelText('Monday, from')).toHaveValue('540');
    expect(screen.getByLabelText('Monday, until')).toHaveValue('720');
    expect(screen.getAllByText('Unavailable')).toHaveLength(6);
    expect(screen.getByLabelText('Minimum notice')).toHaveValue('240');
    const preview = (await screen.findByRole('heading', { name: 'What guests see next week' })).parentElement as HTMLElement;
    expect(await within(preview).findByText('09:00')).toBeInTheDocument();
  });

  it('adds hours and saves everything with one request', async () => {
    const calls = mockApi(ready({ 'PUT /api/availability': ({ body }: { body: unknown }) => body }));
    renderApp('/availability');
    await userEvent.click(await screen.findByRole('button', { name: 'Add hours on Tuesday' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save hours' }));
    expect(await screen.findByText('Saved. Your booking page uses these now.')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ ...AVAILABILITY, rules: [AVAILABILITY.rules[0], { weekday: 2, startMinute: 540, endMinute: 1020 }] });
    // The preview reloads with the saved hours.
    expect(calls.filter((c) => c.url.startsWith('/api/public/')).length).toBe(2);
  });

  it('catches overlapping hours before sending, with the same message as the server', async () => {
    const calls = mockApi(ready());
    renderApp('/availability');
    await userEvent.click(await screen.findByRole('button', { name: 'Add hours on Monday' }));
    await userEvent.selectOptions(screen.getAllByLabelText('Monday, from')[1] as HTMLElement, '660');
    await userEvent.click(screen.getByRole('button', { name: 'Save hours' }));
    expect(await screen.findByText('Monday 09:00-12:00 overlaps 11:00-15:00')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it("shows the server's message when it refuses", async () => {
    mockApi(ready({ 'PUT /api/availability': failing(400, 'Unknown time zone') }));
    renderApp('/availability');
    await userEvent.click(await screen.findByRole('button', { name: 'Save hours' }));
    expect(await screen.findByText('Unknown time zone')).toBeInTheDocument();
  });

  it('says the preview shows saved settings, and flags unsaved edits until they are saved', async () => {
    mockApi(ready({ 'PUT /api/availability': ({ body }: { body: unknown }) => body }));
    renderApp('/availability');
    expect(await screen.findByText('Based on your saved settings, for 30-min call, in your time zone.')).toBeInTheDocument();
    expect(screen.queryByText('You have unsaved changes. Save to see them here.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add hours on Friday' }));
    expect(screen.getByText('You have unsaved changes. Save to see them here.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save hours' }));
    expect(await screen.findByText('Saved. Your booking page uses these now.')).toBeInTheDocument();
    expect(screen.queryByText('You have unsaved changes. Save to see them here.')).not.toBeInTheDocument();
  });

  it('removes hours, leaving the day unavailable', async () => {
    mockApi(ready());
    renderApp('/availability');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Monday 09:00 to 12:00' }));
    expect(screen.getAllByText('Unavailable')).toHaveLength(7);
  });

  it('turns the daily limit on and off', async () => {
    mockApi(ready());
    renderApp('/availability');
    await userEvent.click(await screen.findByLabelText('Limit bookings per day'));
    expect(screen.getByLabelText('At most this many a day')).toHaveValue(4);
  });

  it("explains an empty preview, and a preview that can't load", async () => {
    mockApi(ready({ 'GET /api/public/book/priya/30-min-call/slots': failing(503, "This booking page can't show times right now. Please try again in a few minutes.") }));
    renderApp('/availability');
    expect(await screen.findByText("Can't show free times")).toBeInTheDocument();
  });

  it('asks for an event type before it can preview anything', async () => {
    mockApi(ready({ 'GET /api/event-types': { eventTypes: [] } }));
    renderApp('/availability');
    expect(await screen.findByRole('link', { name: 'Create an event type' })).toBeInTheDocument();
  });

  it('shows a loading state while the hours load', async () => {
    mockApi(ready({ 'GET /api/availability': never }));
    renderApp('/availability');
    expect(await screen.findByText('Loading your hours…')).toBeInTheDocument();
  });

  it('shows an error state when they fail to load', async () => {
    mockApi(ready({ 'GET /api/availability': failing() }));
    renderApp('/availability');
    expect(await screen.findByText("This didn't load")).toBeInTheDocument();
  });
});
