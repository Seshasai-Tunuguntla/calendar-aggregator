import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { availabilitySchema, type Availability } from '@calendar-aggregator/shared';
import { createApp } from '../../src/app.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG, type FakeAccount } from '../helpers/fakeGoogle.ts';
import { signInWithGoogle } from '../helpers/googleSignIn.ts';
import { TEST_HOST } from '../helpers/http.ts';

const db = useTestDatabase();
const HOST: FakeAccount = { sub: '6000000000000000001', email: 'host@gmail.com', name: 'Host' };

let app: ReturnType<typeof createApp>;
let browser: TestBrowser;

const AVAILABILITY: Availability = {
  timeZone: 'America/New_York',
  rules: [
    { weekday: 1, startMinute: 540, endMinute: 720 },
    { weekday: 1, startMinute: 780, endMinute: 1020 },
    { weekday: 3, startMinute: 600, endMinute: 960 },
  ],
  settings: { bufferBeforeMinutes: 10, bufferAfterMinutes: 5, minNoticeMinutes: 120, horizonDays: 60, maxPerDay: 4 },
};

beforeEach(async () => {
  const google = await FakeGoogle.create();
  app = createApp({ db, production: false, rateLimits: false, google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks } });
  browser = new TestBrowser(app);
  await signInWithGoogle(browser, google, HOST, { timeZone: 'Asia/Kolkata' });
});

const current = async () => availabilitySchema.parse((await browser.get('/api/availability')).body);

describe('GET /api/availability', () => {
  it("starts a new host with no hours, the database's default settings and the browser's time zone", async () => {
    expect(await current()).toEqual({
      timeZone: 'Asia/Kolkata',
      rules: [],
      settings: { bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 240, horizonDays: 30, maxPerDay: null },
    });
  });

  it('requires signing in', async () => {
    expect((await new TestBrowser(app).get('/api/availability')).status).toBe(401);
  });
});

describe('PUT /api/availability', () => {
  it('replaces the time zone, rules and settings, and returns rules sorted', async () => {
    const res = await browser.put('/api/availability', { ...AVAILABILITY, rules: AVAILABILITY.rules.toReversed() });
    expect(res.status).toBe(200);
    expect(availabilitySchema.parse(res.body)).toEqual(AVAILABILITY);
    expect(await current()).toEqual(AVAILABILITY);
  });

  it('replaces every rule: rules left out are removed', async () => {
    await browser.put('/api/availability', AVAILABILITY);
    const fewer = { ...AVAILABILITY, rules: [{ weekday: 5, startMinute: 0, endMinute: 1440 }] };
    await browser.put('/api/availability', fewer);
    expect((await current()).rules).toEqual(fewer.rules);
    expect(await db.availabilityRule.count()).toBe(1);
  });

  it.each([
    ['overlapping rules', { rules: [{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 660, endMinute: 840 }] }, 'Monday 09:00-12:00 overlaps 11:00-14:00'],
    ['a rule crossing midnight', { rules: [{ weekday: 2, startMinute: 1320, endMinute: 120 }] }, "A rule can't cross midnight: add one ending at 24:00 and another starting at 00:00 the next day"],
    ['a fixed offset instead of a zone', { timeZone: '+05:30' }, 'Unknown time zone'],
    ['a buffer over 4 hours', { settings: { ...AVAILABILITY.settings, bufferAfterMinutes: 241 } }, 'Buffers are 0 to 240 minutes'],
    ['a zero horizon', { settings: { ...AVAILABILITY.settings, horizonDays: 0 } }, 'Guests can book 1 to 365 days ahead'],
    ['a zero daily limit', { settings: { ...AVAILABILITY.settings, maxPerDay: 0 } }, 'The daily limit is 1 to 50 bookings'],
    ['more than 30 days of notice', { settings: { ...AVAILABILITY.settings, minNoticeMinutes: 43_201 } }, 'Minimum notice is 0 minutes to 30 days'],
  ])('rejects %s with a clear message and changes nothing', async (_name, change, message) => {
    await browser.put('/api/availability', AVAILABILITY);
    const res = await browser.put('/api/availability', { ...AVAILABILITY, ...change });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(message);
    expect(await current()).toEqual(AVAILABILITY);
  });

  it("accepts touching rules (one ends when the next starts), and 'no daily limit'", async () => {
    const touching = {
      ...AVAILABILITY,
      rules: [{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 720, endMinute: 1020 }],
      settings: { ...AVAILABILITY.settings, maxPerDay: null },
    };
    expect((await browser.put('/api/availability', touching)).status).toBe(200);
    expect(await current()).toEqual(touching);
  });

  it('needs the Origin header like every change (CSRF)', async () => {
    const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await request(app).put('/api/availability').set('Host', TEST_HOST).set('Cookie', cookie).send(AVAILABILITY);
    expect(res.status).toBe(403);
  });
});
