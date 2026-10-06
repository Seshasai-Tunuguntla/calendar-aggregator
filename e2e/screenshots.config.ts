import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.ts';

// `npm run screenshots`: the README's screenshots (docs/screenshots/), taken from the real app with
// the same servers as the end-to-end test. Not part of the test run.
export default defineConfig({
  ...base,
  testMatch: 'screenshots.capture.ts',
  reporter: 'list',
  projects: [{ name: 'screenshots', use: { ...devices['Desktop Chrome'] } }],
});
