import { afterAll, beforeEach } from 'vitest';
import { createDb, type Db } from '../../src/db.ts';
import { loadTestEnv } from '../testDatabase.ts';

let db: Db | undefined;

// For test files that use the database: one client per file, and an empty database before each
// test. TRUNCATE ... CASCADE on User empties every table that belongs to a user (sessions,
// connections, calendars, rules, event types, bookings, demo events).
export function useTestDatabase(): Db {
  db ??= createDb(loadTestEnv());
  const client = db;
  beforeEach(async () => {
    await client.$executeRawUnsafe('TRUNCATE "User", "RateLimit" CASCADE');
  });
  afterAll(async () => {
    await client.$disconnect();
  });
  return client;
}
