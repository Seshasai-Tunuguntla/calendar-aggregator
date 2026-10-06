import { defineConfig, devices } from '@playwright/test';

// The end-to-end test runs the production build of the client (vite preview) against the real API
// and its own Postgres database, on ports of its own so it never meets the dev servers (5190/4200).
const API_PORT = 4300;
const WEB_PORT = 5290;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // One demo host is shared by every test: run them one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : 'list',
  outputDir: '../test-results',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    // A guest in London reading British English, whatever the machine running the test is set to.
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
  ],
  webServer: [
    {
      command: 'node e2e/startApi.ts',
      cwd: '..',
      env: { E2E_API_PORT: String(API_PORT) },
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npm run build && npx vite preview --port ${WEB_PORT}`,
      cwd: '../client',
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      url: `http://localhost:${WEB_PORT}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
