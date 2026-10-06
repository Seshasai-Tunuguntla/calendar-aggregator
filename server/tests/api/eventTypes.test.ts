import { beforeEach, describe, expect, it } from 'vitest';
import { eventTypeResponseSchema, eventTypesResponseSchema } from '@calendar-aggregator/shared';
import { createApp } from '../../src/app.ts';
import { MAX_EVENT_TYPES } from '../../src/routes/eventTypes.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { createBooking } from '../helpers/factories.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG, type FakeAccount } from '../helpers/fakeGoogle.ts';
import { signInWithGoogle } from '../helpers/googleSignIn.ts';

const db = useTestDatabase();
const HOST: FakeAccount = { sub: '7000000000000000001', email: 'host@gmail.com', name: 'Sesha Sai' };
const OTHER: FakeAccount = { sub: '7000000000000000002', email: 'other@gmail.com', name: 'Other Host' };

const CALL = { slug: '30-min-call', title: '30-min call', durationMinutes: 30, slotStepMinutes: 30 };

let google: FakeGoogle;
let app: ReturnType<typeof createApp>;
let browser: TestBrowser;

beforeEach(async () => {
  google = await FakeGoogle.create();
  app = createApp({ db, production: false, rateLimits: false, google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks } });
  browser = new TestBrowser(app);
  await signInWithGoogle(browser, google, HOST);
});

const create = async (body: object, b = browser) => b.post('/api/event-types', body);
const list = async (b = browser) => eventTypesResponseSchema.parse((await b.get('/api/event-types')).body).eventTypes;

describe('POST /api/event-types', () => {
  it('creates an event type with its public link, defaulting to active with no description', async () => {
    const res = await create(CALL);
    expect(res.status).toBe(201);
    const { eventType } = eventTypeResponseSchema.parse(res.body);
    expect(eventType).toMatchObject({ ...CALL, description: '', active: true, bookingPath: '/book/sesha-sai/30-min-call' });
    expect(await list()).toEqual([eventType]);
  });

  it('refuses a link the host already uses, but another host can use the same one', async () => {
    await create(CALL);
    const clash = await create({ ...CALL, title: 'Another' });
    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({ error: 'Another of your event types already uses the link "30-min-call"' });

    const other = new TestBrowser(app);
    await signInWithGoogle(other, google, OTHER);
    expect((await create(CALL, other)).status).toBe(201);
  });

  it.each([
    ['a link with spaces or capitals', { slug: 'My Call' }, 'The link can use lowercase letters, digits and hyphens (2 to 60 characters, not starting or ending with a hyphen)'],
    ['a link ending in a hyphen', { slug: 'call-' }, 'The link can use lowercase letters, digits and hyphens (2 to 60 characters, not starting or ending with a hyphen)'],
    ['a blank title', { title: '   ' }, 'Give the event type a title'],
    ['a 4-minute event', { durationMinutes: 4 }, 'Events last 5 to 720 minutes'],
    ['a 13-hour event', { durationMinutes: 780 }, 'Events last 5 to 720 minutes'],
    ['start times 1 minute apart', { slotStepMinutes: 1 }, 'Start times are 5 to 240 minutes apart'],
  ])('rejects %s', async (_name, change, message) => {
    const res = await create({ ...CALL, ...change });
    expect([res.status, res.body.error]).toEqual([400, message]);
    expect(await list()).toEqual([]);
  });

  it('rejects a fractional duration', async () => {
    expect((await create({ ...CALL, durationMinutes: 30.5 })).status).toBe(400);
  });

  it(`allows at most ${MAX_EVENT_TYPES} per host`, async () => {
    const userId = (await db.user.findFirstOrThrow({ where: { email: HOST.email } })).id;
    await db.eventType.createMany({
      data: Array.from({ length: MAX_EVENT_TYPES }, (_, i) => ({ userId, slug: `type-${i}`, title: `Type ${i}`, durationMinutes: 30, slotStepMinutes: 30 })),
    });
    const res = await create(CALL);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: `You can have at most ${MAX_EVENT_TYPES} event types` });
  });

  it('requires signing in', async () => {
    expect((await create(CALL, new TestBrowser(app))).status).toBe(401);
  });
});

describe('PATCH /api/event-types/:id', () => {
  it('changes only the fields sent', async () => {
    const { eventType } = eventTypeResponseSchema.parse((await create({ ...CALL, description: 'Talk it through.' })).body);
    const res = await browser.patch(`/api/event-types/${eventType.id}`, { title: 'Half-hour call', active: false });
    expect(res.status).toBe(200);
    expect(eventTypeResponseSchema.parse(res.body).eventType).toEqual({ ...eventType, title: 'Half-hour call', active: false });
  });

  it('moves the link when the slug changes, and refuses one already in use', async () => {
    const { eventType } = eventTypeResponseSchema.parse((await create(CALL)).body);
    await create({ ...CALL, slug: 'chat' });
    expect(eventTypeResponseSchema.parse((await browser.patch(`/api/event-types/${eventType.id}`, { slug: 'call' })).body).eventType.bookingPath).toBe(
      '/book/sesha-sai/call',
    );
    expect((await browser.patch(`/api/event-types/${eventType.id}`, { slug: 'chat' })).status).toBe(409);
  });

  it("can't change another host's event type (404, as if it didn't exist)", async () => {
    const { eventType } = eventTypeResponseSchema.parse((await create(CALL)).body);
    const other = new TestBrowser(app);
    await signInWithGoogle(other, google, OTHER);
    expect((await other.patch(`/api/event-types/${eventType.id}`, { title: 'Mine now' })).status).toBe(404);
    expect((await browser.patch('/api/event-types/not-a-uuid', { title: 'x' })).status).toBe(404);
    expect((await list())[0]?.title).toBe(CALL.title);
  });
});

describe('DELETE /api/event-types/:id', () => {
  it('deletes an event type without bookings', async () => {
    const { eventType } = eventTypeResponseSchema.parse((await create(CALL)).body);
    expect((await browser.delete(`/api/event-types/${eventType.id}`)).status).toBe(204);
    expect(await list()).toEqual([]);
  });

  it("refuses to delete one with bookings (they'd be lost), and suggests turning it off", async () => {
    const { eventType } = eventTypeResponseSchema.parse((await create(CALL)).body);
    const userId = (await db.user.findFirstOrThrow({ where: { email: HOST.email } })).id;
    await createBooking(db, { eventTypeId: eventType.id, hostId: userId, start: '2026-10-12T09:00Z', end: '2026-10-12T09:30Z' });
    const res = await browser.delete(`/api/event-types/${eventType.id}`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "This event type has bookings, so it can't be deleted. Turn it off instead." });
    expect(await list()).toHaveLength(1);
  });

  it("can't delete another host's event type", async () => {
    const { eventType } = eventTypeResponseSchema.parse((await create(CALL)).body);
    const other = new TestBrowser(app);
    await signInWithGoogle(other, google, OTHER);
    expect((await other.delete(`/api/event-types/${eventType.id}`)).status).toBe(404);
    expect(await list()).toHaveLength(1);
  });
});
