import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db.ts';
import { claimTestDatabase, useTestDatabase } from '../helpers/db.ts';
import { loadTestEnv } from '../testDatabase.ts';

useTestDatabase();
// Another connection to the same database, as a second test run (or a file run in parallel) has.
const other = createDb(loadTestEnv());

afterAll(async () => {
  await other.$disconnect();
});

describe('the test database guard', () => {
  it('stops a second test run from using the database while this file has it, with a clear message', async () => {
    await expect(claimTestDatabase(other)).rejects.toThrow(/must run one file at a time/);
  });
});
