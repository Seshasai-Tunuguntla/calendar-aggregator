import type { BusyAccess } from '@prisma/client';
import { z } from 'zod';
import { DAY_MS, type Interval } from '@calendar-aggregator/shared/slots';
import type { GoogleTokens } from '../google/tokens.ts';
import {
  CalendarProviderError,
  type CalendarProvider,
  type ConnectionRef,
  type ExternalCalendar,
  type NewCalendarEvent,
} from './provider.ts';

// The real Google Calendar API, behind the same interface as the demo provider.
//
// Privacy: only three read endpoints are used. calendarList gives names and access roles (shown
// to the host only), freeBusy gives busy intervals. Event titles, attendees and descriptions are
// never requested, so they can't leak or be stored.
//
// Errors (Google's guide: developers.google.com/workspace/calendar/api/guides/errors):
// - 401: our access token was rejected. Refresh it once and retry; if that fails, 'auth'.
// - 403 insufficientPermissions: a scope is missing; the connection needs reconnecting ('auth').
// - 403 rateLimitExceeded / userRateLimitExceeded, 429, 5xx, network errors: retried twice with
//   exponential backoff (or Retry-After), then 'rate_limited' or 'unavailable'.
// - 404 / other 403: the calendar or event doesn't exist or isn't reachable: 'not_found'.

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// freeBusy accepts at most 50 calendars per request. Its maximum time range isn't documented by
// Google; ~90 days is reported elsewhere, so ranges are split into 60-day windows.
const MAX_CALENDARS_PER_QUERY = 50;
const MAX_RANGE_MS = 60 * DAY_MS;
const MAX_RETRIES = 2;
// checkBusyAccess only needs freeBusy's per-calendar answer, not busy times; any short range works.
const ACCESS_CHECK_RANGE_MS = 60 * 60 * 1000;
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

const calendarListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().optional(),
        summaryOverride: z.string().optional(),
        primary: z.boolean().optional(),
        accessRole: z.string(),
        deleted: z.boolean().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

const freeBusySchema = z.object({
  calendars: z.record(
    z.string(),
    z.object({
      busy: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
      errors: z.array(z.object({ reason: z.string() })).optional(),
    }),
  ),
});

const createdEventSchema = z.object({ id: z.string() });

const googleErrorSchema = z.object({
  error: z.object({
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GoogleCalendarProvider implements CalendarProvider {
  readonly #tokens: GoogleTokens;
  readonly #fetch: typeof fetch;
  readonly #sleep: Sleep;

  constructor({ tokens, fetch: fetchFn, sleep = realSleep }: { tokens: GoogleTokens; fetch: typeof fetch; sleep?: Sleep }) {
    this.#tokens = tokens;
    this.#fetch = fetchFn;
    this.#sleep = sleep;
  }

  async listCalendars(connection: ConnectionRef): Promise<ExternalCalendar[]> {
    const calendars: ExternalCalendar[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ maxResults: '250' });
      if (pageToken) params.set('pageToken', pageToken);
      const { body } = await this.#call(connection, 'GET', `/users/me/calendarList?${params}`);
      const page = parse(calendarListSchema, body);
      for (const item of page.items) {
        if (item.deleted) continue;
        calendars.push({
          externalCalendarId: item.id,
          name: item.summaryOverride ?? item.summary ?? item.id,
          isPrimary: item.primary === true,
          // calendar.events.owned lets us create events only in calendars the user owns.
          canCreateEvents: item.accessRole === 'owner',
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    return calendars.toSorted((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name));
  }

  // Fails closed: if any of the calendars can't be read, this throws instead of returning partial
  // busy time. Offering slots without knowing a calendar's busy time could double-book the host.
  async getBusyIntervals(connection: ConnectionRef, externalCalendarIds: readonly string[], range: Interval): Promise<Interval[]> {
    if (externalCalendarIds.length === 0 || range.end <= range.start) return [];

    const intervals: Interval[] = [];
    for (const window of splitRange(range, MAX_RANGE_MS)) {
      for (const ids of chunk(externalCalendarIds, MAX_CALENDARS_PER_QUERY)) {
        const { body } = await this.#call(connection, 'POST', '/freeBusy', {
          timeMin: new Date(window.start).toISOString(),
          timeMax: new Date(window.end).toISOString(),
          items: ids.map((id) => ({ id })),
        });
        const result = parse(freeBusySchema, body);
        for (const id of ids) {
          const calendar = result.calendars[id];
          const reason = calendar?.errors?.[0]?.reason;
          if (!calendar || reason) {
            const kind = reason === 'notFound' ? 'not_found' : 'unavailable';
            throw new CalendarProviderError(kind, `Can't read free/busy for a calendar (${reason ?? 'missing from the response'})`, { externalCalendarId: id });
          }
          for (const busy of calendar.busy) intervals.push({ start: Date.parse(busy.start), end: Date.parse(busy.end) });
        }
      }
    }
    return intervals;
  }

  // One freeBusy request per 50 calendars. Google answers notFound for a calendar it won't serve
  // free/busy for (checked on a real account: holiday calendars, under either free/busy scope),
  // which is permanent; any other per-calendar error (backendError, internalError...) may pass.
  async checkBusyAccess(connection: ConnectionRef, externalCalendarIds: readonly string[]): Promise<Map<string, BusyAccess>> {
    const access = new Map<string, BusyAccess>();
    const start = Date.now();
    for (const ids of chunk(externalCalendarIds, MAX_CALENDARS_PER_QUERY)) {
      const { body } = await this.#call(connection, 'POST', '/freeBusy', {
        timeMin: new Date(start).toISOString(),
        timeMax: new Date(start + ACCESS_CHECK_RANGE_MS).toISOString(),
        items: ids.map((id) => ({ id })),
      });
      const result = parse(freeBusySchema, body);
      for (const id of ids) {
        const calendar = result.calendars[id];
        const reason = calendar?.errors?.[0]?.reason;
        access.set(id, !calendar ? 'UNKNOWN' : reason === 'notFound' ? 'UNREADABLE' : reason ? 'UNKNOWN' : 'READABLE');
      }
    }
    return access;
  }

  // sendUpdates=all: Google emails the invitation to the guest. The event id is derived from our
  // idempotency key (a UUID's hex digits are valid in Google's base32hex ids), so if a retry after
  // a timeout creates it again, Google answers 409 duplicate and we return the same id.
  async createEvent(connection: ConnectionRef, event: NewCalendarEvent): Promise<{ externalEventId: string }> {
    const eventId = googleEventId(event.idempotencyKey);
    const { status, body } = await this.#call(
      connection,
      'POST',
      `/calendars/${encodeURIComponent(event.externalCalendarId)}/events?sendUpdates=all`,
      {
        id: eventId,
        summary: event.summary,
        description: event.description,
        start: { dateTime: event.start.toISOString() },
        end: { dateTime: event.end.toISOString() },
        attendees: event.attendees.map((attendee) => ({ email: attendee.email, displayName: attendee.name })),
        reminders: { useDefault: true },
      },
      { expected: [409] },
      event.externalCalendarId,
    );
    if (status === 409) return { externalEventId: eventId };
    return { externalEventId: parse(createdEventSchema, body).id };
  }

  // sendUpdates=all: Google tells the guest it's cancelled. 404 and 410 (already deleted) count
  // as success, so deleting is idempotent.
  async deleteEvent(connection: ConnectionRef, externalCalendarId: string, externalEventId: string): Promise<void> {
    await this.#call(
      connection,
      'DELETE',
      `/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(externalEventId)}?sendUpdates=all`,
      undefined,
      { expected: [404, 410] },
      externalCalendarId,
    );
  }

  async #call(
    connection: ConnectionRef,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    requestBody?: unknown,
    { expected = [] }: { expected?: number[] } = {},
    externalCalendarId?: string,
  ): Promise<{ status: number; body: unknown }> {
    if (connection.provider !== 'GOOGLE') throw new Error(`GoogleCalendarProvider can't serve a ${connection.provider} connection`);
    const about = externalCalendarId === undefined ? {} : { externalCalendarId };

    let token = await this.#tokens.accessToken(connection.id);
    let refreshedAfter401 = false;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(`${CALENDAR_API}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(requestBody === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        if (attempt < MAX_RETRIES) {
          await this.#sleep(backoffMs(attempt));
          continue;
        }
        throw new CalendarProviderError('unavailable', "Couldn't reach Google Calendar", about);
      }

      if (response.ok || expected.includes(response.status)) {
        const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
        return { status: response.status, body };
      }

      const reasons = await errorReasons(response);
      if (response.status === 401) {
        if (refreshedAfter401) throw new CalendarProviderError('auth', 'Google rejected the refreshed access token', about);
        refreshedAfter401 = true;
        token = await this.#tokens.accessToken(connection.id, { forceRefresh: true });
        continue;
      }
      if (response.status === 403 && (reasons.has('insufficientPermissions') || reasons.has('ACCESS_TOKEN_SCOPE_INSUFFICIENT'))) {
        await this.#tokens.markNeedsReconnect(connection.id);
        throw new CalendarProviderError('auth', 'Google Calendar access is missing a permission', about);
      }

      const rateLimited = response.status === 429 || (response.status === 403 && [...reasons].some((r) => RATE_LIMIT_REASONS.has(r)));
      if (rateLimited || response.status >= 500) {
        if (attempt < MAX_RETRIES) {
          await this.#sleep(retryAfterMs(response) ?? backoffMs(attempt));
          continue;
        }
        throw new CalendarProviderError(rateLimited ? 'rate_limited' : 'unavailable', `Google Calendar answered ${response.status}`, about);
      }
      if (response.status === 403 || response.status === 404) {
        throw new CalendarProviderError('not_found', `Google Calendar answered ${response.status}: not found or no access`, about);
      }
      throw new CalendarProviderError('unavailable', `Google Calendar answered ${response.status}`, about);
    }
  }
}

// Google event ids use base32hex (0-9, a-v), 5-1024 characters; a UUID's hex digits qualify.
export function googleEventId(uuid: string): string {
  return uuid.replaceAll('-', '').toLowerCase();
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new CalendarProviderError('unavailable', 'Unexpected response from Google Calendar');
  return result.data;
}

async function errorReasons(response: Response): Promise<Set<string>> {
  const parsed = googleErrorSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return new Set();
  const { errors = [], details = [] } = parsed.data.error;
  return new Set([...errors, ...details].map((e) => e.reason).filter((r): r is string => r !== undefined));
}

// 250 ms, 500 ms, ... with up to 100 ms of jitter, so many clients don't retry in lockstep.
function backoffMs(attempt: number): number {
  return 250 * 2 ** attempt + Math.floor(Math.random() * 100);
}

// Google's Retry-After, in seconds, capped so a booking request never waits long.
function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 5) * 1000 : undefined;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function splitRange(range: Interval, maxMs: number): Interval[] {
  const windows: Interval[] = [];
  for (let start = range.start; start < range.end; start += maxMs) windows.push({ start, end: Math.min(start + maxMs, range.end) });
  return windows;
}
