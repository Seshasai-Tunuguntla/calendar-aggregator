import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.ts';

// `npm run screenshots`: the README's screenshots (docs/screenshots/), taken from the real app with
// the same servers as the end-to-end test, or from a deployed site with LIVE_URL=<site> (so the
// booking links show its real address). Not part of the test run.
const live = process.env['LIVE_URL'];

export default defineConfig({
  ...base,
  testMatch: 'screenshots.capture.ts',
  reporter: 'list',
  projects: [{ name: 'screenshots', use: { ...devices['Desktop Chrome'] } }],
  ...(live ? { use: { ...base.use, baseURL: live }, webServer: undefined } : {}),
});
