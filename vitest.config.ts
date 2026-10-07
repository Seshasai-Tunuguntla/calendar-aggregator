import { defineConfig } from 'vitest/config';

// `npx vitest` from the repo root: each workspace runs as its own project with its own settings
// (jsdom for the client; the server's test database setup, one file at a time). `npm test` runs
// the same tests workspace by workspace. The Playwright tests in e2e/ are not Vitest's.
export default defineConfig({
  test: {
    projects: ['shared/vitest.config.ts', 'server/vitest.config.ts', 'client/vite.config.ts'],
  },
});
