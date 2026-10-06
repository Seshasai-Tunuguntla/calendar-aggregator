import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { e2eDatabaseUrl } from './database.ts';

// Starts the API for the end-to-end test (Playwright's webServer runs this): migrates the test's
// own database the way production is migrated, empties it so every run starts with a demo that
// has never been built and no rate-limit counts, then runs the ordinary server on E2E_API_PORT.
// Google sign-in stays off: the demo flow doesn't need it.
const url = e2eDatabaseUrl();
execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: fileURLToPath(new URL('../server', import.meta.url)),
  env: { ...process.env, DATABASE_URL: url },
  stdio: 'pipe',
});
const db = new PrismaClient({ datasourceUrl: url });
await db.$executeRawUnsafe('TRUNCATE "User", "RateLimit", "DemoState" CASCADE');
await db.$disconnect();

for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NODE_ENV']) delete process.env[name];
process.env['DATABASE_URL'] = url;
process.env['PORT'] = process.env['E2E_API_PORT'] ?? '4300';
await import('../server/src/server.ts');
