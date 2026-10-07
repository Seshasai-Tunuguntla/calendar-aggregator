import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrationDatabaseUrl } from '../../scripts/vercelBuild.ts';
import { FUNCTION_MAX_DURATION_S } from '../../src/bookings/timeouts.ts';
import { createVercelApp } from '../../src/vercel.ts';

const UNPOOLED = 'postgresql://user@direct.example/db';
const vercelJson = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8')) as {
  buildCommand: string;
  outputDirectory: string;
  functions: Record<string, { maxDuration: number }>;
  rewrites: { source: string; destination: string }[];
  redirects: { source: string; has: { type: string; value: string }[]; destination: string; permanent: boolean }[];
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the Vercel build', () => {
  it('migrates production over the direct connection', () => {
    expect(migrationDatabaseUrl({ VERCEL_ENV: 'production', DATABASE_URL: 'pooled', DATABASE_URL_UNPOOLED: UNPOOLED })).toBe(UNPOOLED);
    expect(() => migrationDatabaseUrl({ VERCEL_ENV: 'production', DATABASE_URL: 'pooled' })).toThrow(/DATABASE_URL_UNPOOLED/);
  });

  it('never migrates from a preview, even one that was given the database settings, unless it has its own database', () => {
    expect(migrationDatabaseUrl({ VERCEL_ENV: 'preview', DATABASE_URL_UNPOOLED: UNPOOLED })).toBeNull();
    expect(migrationDatabaseUrl({ VERCEL_ENV: 'preview', PREVIEW_HAS_OWN_DATABASE: 'true', DATABASE_URL_UNPOOLED: UNPOOLED })).toBe(UNPOOLED);
    expect(migrationDatabaseUrl({ VERCEL_ENV: 'development', DATABASE_URL_UNPOOLED: UNPOOLED })).toBeNull();
    expect(migrationDatabaseUrl({})).toBeNull();
  });

  it('is the build vercel.json runs, with the client as the static output', () => {
    expect(vercelJson.buildCommand).toBe('node server/scripts/vercelBuild.ts');
    expect(vercelJson.outputDirectory).toBe('client/dist');
  });
});

describe('the Vercel function', () => {
  it('gets the 60 seconds the booking time limits are planned around', () => {
    expect(vercelJson.functions['api/index.ts']?.maxDuration).toBe(FUNCTION_MAX_DURATION_S);
  });

  it('serves every /api path, and the client app everything else', () => {
    expect(vercelJson.rewrites).toEqual([
      { source: '/api/(.*)', destination: '/api' },
      { source: '/(.*)', destination: '/index.html' },
    ]);
  });

  it('sends the old addresses to the live one, permanently, keeping the path, and never to themselves', () => {
    const live = /\*\*Live demo: <(https:\/\/[^>]+)>\*\*/.exec(readFileSync(new URL('../../../README.md', import.meta.url), 'utf8'))?.[1] ?? '';
    expect(vercelJson.redirects.map((r) => r.has[0]?.value)).toEqual(['calendar-aggregator-beta.vercel.app', 'calendar-aggregator-seshasais-projects.vercel.app']);
    for (const redirect of vercelJson.redirects) {
      expect(redirect).toMatchObject({ source: '/(.*)', destination: `${live}/$1`, permanent: true });
      expect(redirect.has).toEqual([{ type: 'host', value: expect.not.stringMatching(new URL(live).host) }]);
    }
  });

  it("switches the API off in a preview without its own database, even if it was given the production database's settings", async () => {
    const app = createVercelApp({ VERCEL_ENV: 'preview', NODE_ENV: 'production', DATABASE_URL: 'postgresql://user@production.example/db' });
    for (const res of [await request(app).get('/api/health'), await request(app).post('/api/auth/demo')]) {
      expect([res.status, res.body]).toEqual([503, { error: 'This preview deployment has no database of its own, so its API is switched off.' }]);
    }
  });

  it('answers 503 when settings are missing, logging their names but never any value', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createVercelApp({ VERCEL_ENV: 'production', NODE_ENV: 'production', DATABASE_URL: 'postgresql://user:hunter2@db.example/db', GOOGLE_CLIENT_ID: 'id' });
    const res = await request(app).get('/api/health');
    expect([res.status, res.body]).toEqual([503, { error: 'The API is not configured yet.' }]);
    expect(log).toHaveBeenCalledWith('API not started; missing environment variable(s): GOOGLE_CLIENT_SECRET, APP_ORIGIN, COOKIE_SIGNING_SECRET, TOKEN_ENCRYPTION_KEYS');
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
  });

  it('runs the API when configured', async () => {
    const app = createVercelApp({ DATABASE_URL: 'postgresql://user@localhost:5432/unused_test' });
    expect((await request(app).get('/api/health')).body).toEqual({ status: 'ok' });
  });

  it("logs client addresses only when asked to, for checking a new deployment's rate limiting", async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const env = { DATABASE_URL: 'postgresql://user@localhost:5432/unused_test' };
    await request(createVercelApp(env)).get('/api/health').set('X-Forwarded-For', '203.0.113.9');
    expect(info).not.toHaveBeenCalled();
    await request(createVercelApp({ ...env, LOG_CLIENT_IP: 'true' })).get('/api/health').set('X-Forwarded-For', '198.51.100.1, 203.0.113.9');
    // One trusted proxy (Vercel's edge): the last address is the visitor's, the earlier one is ignored.
    expect(info).toHaveBeenCalledWith('client address: req.ip=203.0.113.9 limiter key=203.0.113.9 x-forwarded-for="198.51.100.1, 203.0.113.9" x-real-ip=null');
  });
});
