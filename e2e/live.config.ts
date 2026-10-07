import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

// `LIVE_URL=https://... npm run e2e:live`: the same end-to-end tests against a deployed site, as a
// smoke test after deploying (no local servers). It books and cancels one demo booking per screen
// width, which stays within the booking rate limit.
const url = process.env['LIVE_URL'];
if (!url) throw new Error('Set LIVE_URL to the deployed site, e.g. LIVE_URL=https://calendar-aggregator-app.vercel.app');

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: url },
  webServer: undefined,
});
