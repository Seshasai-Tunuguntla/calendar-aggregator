import { PrismaClient } from '@prisma/client';

export type Db = PrismaClient;

// One client per process (one per serverless instance). The app receives it as a dependency
// (createApp({ db })), so tests pass their own client for the test database.
export function createDb(databaseUrl: string): Db {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}
