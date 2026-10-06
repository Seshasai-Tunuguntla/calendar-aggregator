import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// The end-to-end test's own database: E2E_DATABASE_URL (CI sets it), or locally the test
// database's server with a database named like it but ending in _e2e. Like the unit tests' guard,
// it refuses any database whose name doesn't end in _e2e, because each run empties it.
export function e2eDatabaseUrl(): string {
  let url = process.env['E2E_DATABASE_URL'];
  if (!url) {
    let testEnv: Record<string, string | undefined> = {};
    try {
      testEnv = parseEnv(readFileSync(new URL('../server/.env.test', import.meta.url), 'utf8'));
    } catch {
      // No server/.env.test: E2E_DATABASE_URL must be set instead.
    }
    const testUrl = testEnv['DATABASE_URL'];
    if (!testUrl) throw new Error('Set E2E_DATABASE_URL, or copy server/.env.test.example to server/.env.test');
    const derived = new URL(testUrl);
    derived.pathname = derived.pathname.replace(/_test$/, '_e2e');
    url = derived.toString();
  }
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith('_e2e')) throw new Error(`Refusing to use database "${name}" for the end-to-end test: its name must end in _e2e`);
  return url;
}
