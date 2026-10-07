import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    // Loads .env.test and migrates the test database once, before any test file runs.
    globalSetup: ['./tests/globalSetup.ts'],
    setupFiles: ['./tests/setupEnv.ts'],
    // The database tests share one test database and empty it between tests, so files run one at
    // a time (the same as Jest's --runInBand in the earlier projects).
    fileParallelism: false,
  },
});
