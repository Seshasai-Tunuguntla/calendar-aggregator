import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { slugify } from '../../src/pages/EventTypesPage.tsx';
import { HOST, failing, mockApi, renderApp, signedInAs } from '../helpers/app.tsx';
import { eventType } from '../helpers/fixtures.ts';

const ready = (overrides: Record<string, unknown> = {}) => ({ ...signedInAs(), 'GET /api/event-types': { eventTypes: [eventType()] }, ...overrides });

describe('the event types page', () => {
  it('creates an event type, its link following the title', async () => {
    let list = [eventType()];
    const calls = mockApi(
      ready({
        'GET /api/event-types': () => ({ eventTypes: list }),
        'POST /api/event-types': ({ body }: { body: { title: string; slug: string } }) => {
          const created = eventType({ id: '0190a5a4-0000-7000-8000-000000000031', title: body.title, slug: body.slug, bookingPath: `/book/priya/${body.slug}` });
          list = [...list, created];
          return Response.json({ eventType: created }, { status: 201 });
        },
      }),
    );
    renderApp('/event-types');
    await userEvent.click(await screen.findByRole('button', { name: 'New event type' }));
    await userEvent.type(screen.getByLabelText('Title'), 'Café chat!');
    expect(screen.getByLabelText('Link')).toHaveValue('cafe-chat');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('heading', { name: 'Café chat!' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ title: 'Café chat!', slug: 'cafe-chat', durationMinutes: 30, slotStepMinutes: 30 });
  });

  it("shows the server's reason when a link is taken", async () => {
    mockApi(ready({ 'POST /api/event-types': failing(409, 'Another of your event types already uses the link "30-min-call"') }));
    renderApp('/event-types');
    await userEvent.click(await screen.findByRole('button', { name: 'New event type' }));
    await userEvent.type(screen.getByLabelText('Title'), '30-min call');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Another of your event types already uses the link "30-min-call"')).toBeInTheDocument();
  });

  it('refuses a blank title before sending', async () => {
    const calls = mockApi(ready());
    renderApp('/event-types');
    await userEvent.click(await screen.findByRole('button', { name: 'New event type' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Give the event type a title')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('turns an event type off, and explains why one with bookings can\'t be deleted', async () => {
    const calls = mockApi(
      ready({
        [`PATCH /api/event-types/${eventType().id}`]: { eventType: { ...eventType(), active: false } },
        [`DELETE /api/event-types/${eventType().id}`]: failing(409, "This event type has bookings, so it can't be deleted. Turn it off instead."),
      }),
    );
    renderApp('/event-types');
    await userEvent.click(await screen.findByLabelText('Bookable'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ active: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText("This event type has bookings, so it can't be deleted. Turn it off instead.")).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    mockApi(ready({ 'GET /api/event-types': { eventTypes: [] } }));
    renderApp('/event-types');
    expect(await screen.findByText('No event types yet')).toBeInTheDocument();
  });

  it('makes links from titles', () => {
    expect(slugify('  30-min Call!! ')).toBe('30-min-call');
    expect(slugify('Café & croissant')).toBe('cafe-croissant');
  });
});

describe('the account page', () => {
  it('deletes the account only once the handle is typed, then says what happened', async () => {
    const calls = mockApi({ ...signedInAs(), 'DELETE /api/account': { revokedAtGoogle: true, eventsNotDeleted: 1 } });
    const router = renderApp('/account');
    const button = await screen.findByRole('button', { name: 'Delete my account' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Type your handle, priya, to confirm'), 'pri');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Type your handle, priya, to confirm'), 'ya');
    expect(button).toBeEnabled();
    await userEvent.click(button);

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText('Your account was deleted')).toBeInTheDocument();
    expect(screen.getByText(/1 upcoming event couldn't be removed from your calendar/)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't reach Google/)).not.toBeInTheDocument();
    expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({ confirmHandle: 'priya' });
  });

  it('shows why a deletion failed, and stays signed in', async () => {
    mockApi({ ...signedInAs(), 'DELETE /api/account': failing(400, 'Type your handle, priya, to confirm') });
    renderApp('/account');
    await userEvent.type(await screen.findByLabelText('Type your handle, priya, to confirm'), 'priya');
    await userEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByText('Type your handle, priya, to confirm', { selector: '.field__error' })).toBeInTheDocument();
  });

  it("explains that the demo account can't be deleted", async () => {
    mockApi(signedInAs({ ...HOST, isDemo: true }));
    renderApp('/account');
    expect(await screen.findByText(/The demo account is shared by every visitor/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete my account' })).not.toBeInTheDocument();
  });

  it('signs out', async () => {
    let signedIn = true;
    mockApi({
      'GET /api/auth/me': () => (signedIn ? { user: HOST } : Response.json({ error: 'Not signed in' }, { status: 401 })),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return new Response(null, { status: 204 });
      },
    });
    const router = renderApp('/account');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

describe('fonts', () => {
  it('are self-hosted: nothing in the page or styles asks a font service', () => {
    for (const file of ['index.html', 'src/styles/tokens.css', 'src/styles/app.css', 'src/main.tsx']) {
      expect(readFileSync(join(import.meta.dirname, '../..', file), 'utf8')).not.toMatch(/fonts\.(googleapis|gstatic)\.com|use\.typekit|fonts\.bunny/);
    }
  });

  it('load one weight of the heading serif, Latin only', () => {
    const main = readFileSync(join(import.meta.dirname, '../../src/main.tsx'), 'utf8');
    expect(main.match(/@fontsource\/[^'"]+/g)).toEqual(['@fontsource/fraunces/latin-600.css']);
  });
});
