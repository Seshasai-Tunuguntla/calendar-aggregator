import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTestEnv } from '../testDatabase.ts';

const serverDir = fileURLToPath(new URL('../..', import.meta.url));

describe('migrations', () => {
  // After every migration has run, the database must match schema.prisma: a model changed without
  // a migration (or a migration that doesn't match the schema) fails here. Prisma ignores the
  // hand-written CHECK and EXCLUDE constraints when comparing, which constraints.test.ts covers.
  it('leave the database exactly as schema.prisma describes', () => {
    const output = execFileSync(
      'npx',
      ['prisma', 'migrate', 'diff', '--from-url', loadTestEnv(), '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
      { cwd: serverDir, encoding: 'utf8', env: process.env },
    );
    expect(output.trim()).toBe('-- This is an empty migration.');
  }, 30_000);
});
