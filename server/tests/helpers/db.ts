import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createDb, type Db } from '../../src/db.ts';
import { loadTestEnv } from '../testDatabase.ts';

let db: Db | undefined;

// The test files share one test database and empty it before each test, so they must run one at a
// time (vitest.config.ts: fileParallelism: false). Each file holds this session-level advisory lock
// while it runs; one started alongside another gets a clear error instead of tests failing at random
// as they empty the database under each other. The lock goes when the file's client disconnects.
export const TEST_DATABASE_LOCK = 'calendar-aggregator:test-database-in-use';

export async function claimTestDatabase(client: Db): Promise<void> {
  const [row] = await client.$queryRaw<{ claimed: boolean }[]>`SELECT pg_try_advisory_lock(hashtextextended(${TEST_DATABASE_LOCK}, 0)) AS claimed`;
  if (!row?.claimed) {
    throw new Error(
      'Another test file is using the test database right now. The server tests must run one file at a time: ' +
        'use `npm test` (or `npx vitest` from the repo root), and not --fileParallelism or a second test run against the same database.',
    );
  }
}

// For test files that use the database: one client per file, and an empty database before each
// test. TRUNCATE ... CASCADE on User empties every table that belongs to a user (sessions,
// connections, calendars, rules, event types, bookings, demo events); DemoState goes too, so each
// test starts with a demo that has never been built.
export function useTestDatabase(): Db {
  db ??= createDb(loadTestEnv());
  const client = db;
  beforeAll(async () => {
    await claimTestDatabase(client);
  });
  beforeEach(async () => {
    await client.$executeRawUnsafe('TRUNCATE "User", "RateLimit", "DemoState" CASCADE');
  });
  afterAll(async () => {
    await client.$disconnect();
  });
  return client;
}
