// Loads the test settings and returns the test database URL. Refuses to continue unless the
// database's name ends in _test, so a misconfigured environment can never migrate or wipe the
// development (or production) database.
export function loadTestEnv(): string {
  try {
    process.loadEnvFile(new URL('../.env.test', import.meta.url));
  } catch {
    // No .env.test file: CI sets DATABASE_URL in the environment instead.
  }
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set: copy server/.env.test.example to server/.env.test');
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to use database "${name}" for tests: its name must end in _test`);
  }
  return url;
}
