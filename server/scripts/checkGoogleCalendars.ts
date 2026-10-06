// npm run google:check --workspace server
//
// Checks real Google accounts connected in the local database (sign in at
// http://localhost:5190/api/auth/google/start first). For each calendar: whether the user owns it
// and whether freeBusy can read it with the scopes granted (phase 5 used this to find that
// calendar.freebusy doesn't cover subscribed calendars). Also tries one 120-day freeBusy request,
// which Google rejects (timeRangeTooLong), as a reminder that ranges must be split.
//
// Prints calendar names, ownership, counts of busy blocks and error reasons. Never tokens, never
// event details (freeBusy has none anyway).
import { CalendarProviderError } from '../src/calendar/provider.ts';
import { CALENDAR_API, GoogleCalendarProvider } from '../src/calendar/googleProvider.ts';
import { createDb } from '../src/db.ts';
import { googleAuthConfigFromEnv } from '../src/google/config.ts';
import { createGoogleOAuthClient } from '../src/google/oauthClient.ts';
import { GoogleTokens } from '../src/google/tokens.ts';

try {
  process.loadEnvFile('.env');
} catch {
  // Use the environment as it is.
}

const config = googleAuthConfigFromEnv();
const databaseUrl = process.env['DATABASE_URL'];
if (!config || !databaseUrl) throw new Error('Set DATABASE_URL and the Google settings in server/.env first (docs/google-setup.md)');

const db = createDb(databaseUrl);
const tokens = new GoogleTokens({ db, oauth: createGoogleOAuthClient(config, fetch), keyring: config.keyring, now: () => new Date() });
const provider = new GoogleCalendarProvider({ tokens, fetch });

try {
  const connections = await db.calendarConnection.findMany({ where: { provider: 'GOOGLE' } });
  if (connections.length === 0) console.info('No Google connections yet: sign in at http://localhost:5190/api/auth/google/start');

  for (const connection of connections) {
    console.info(`\n${connection.accountEmail} (${connection.status})`);
    console.info(`  granted: ${connection.grantedScopes.filter((s) => s.includes('calendar')).map((s) => s.split('/').pop()).join(', ')}`);
    if (connection.status !== 'ACTIVE') continue;

    const now = Date.now();
    const week = { start: now, end: now + 7 * 24 * 60 * 60 * 1000 };
    for (const calendar of await provider.listCalendars(connection)) {
      let result: string;
      try {
        const busy = await provider.getBusyIntervals(connection, [calendar.externalCalendarId], week);
        result = `readable (${busy.length} busy block${busy.length === 1 ? '' : 's'} in the next 7 days)`;
      } catch (error) {
        result = error instanceof CalendarProviderError ? `NOT readable: ${error.kind}: ${error.message}` : `error: ${String(error)}`;
      }
      const owner = calendar.canCreateEvents ? 'owned    ' : 'not owned';
      console.info(`  ${owner}  ${calendar.name.slice(0, 40).padEnd(40)}  ${result}`);
    }

    // One raw request over 120 days on the primary calendar (the provider itself splits at 60).
    const response = await fetch(`${CALENDAR_API}/freeBusy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await tokens.accessToken(connection.id)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: new Date(now).toISOString(),
        timeMax: new Date(now + 120 * 24 * 60 * 60 * 1000).toISOString(),
        items: [{ id: 'primary' }],
      }),
    });
    const body = (await response.json().catch(() => null)) as { error?: { errors?: { reason?: string }[] } } | null;
    console.info(`  one 120-day freeBusy request: HTTP ${response.status}${body?.error ? ` (${body.error.errors?.[0]?.reason ?? 'error'})` : ''}`);
  }
} finally {
  await db.$disconnect();
}
