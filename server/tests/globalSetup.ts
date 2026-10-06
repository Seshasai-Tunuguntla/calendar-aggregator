import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTestEnv } from './testDatabase.ts';

// Runs once before all test files: brings the test database up to the latest migration, the same
// way production is migrated (migrate deploy, never migrate dev).
export default function setup(): void {
  const databaseUrl = loadTestEnv();
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
  } catch (error) {
    const output = (error as { stdout?: Buffer; stderr?: Buffer });
    throw new Error(`Migrating the test database failed:\n${output.stdout ?? ''}${output.stderr ?? ''}`, { cause: error });
  }
}
