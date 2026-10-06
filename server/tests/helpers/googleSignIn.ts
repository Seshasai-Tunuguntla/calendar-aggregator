import type { FakeAccount, FakeGoogle } from './fakeGoogle.ts';
import type { TestBrowser } from './browser.ts';

// Signs a browser in (or connects another account) through the whole Google flow against the
// fake Google: start -> consent -> callback. Like a browser, it follows the app's one restart with
// prompt=consent (when Google returned no refresh token and none is stored).
export async function signInWithGoogle(
  browser: TestBrowser,
  google: FakeGoogle,
  account: FakeAccount,
  { intent = 'signin', timeZone = 'Asia/Kolkata' }: { intent?: 'signin' | 'connect'; timeZone?: string } = {},
) {
  let start = `/api/auth/google/start?${new URLSearchParams({ intent, tz: timeZone })}`;
  for (let attempt = 0; ; attempt++) {
    const redirect = await browser.get(start);
    const params = google.approve(redirect.headers['location'] as string, account);
    const callback = await browser.get(`/api/auth/google/callback?${new URLSearchParams(params)}`);
    const next = String(callback.headers['location'] ?? '');
    if (attempt > 0 || !next.startsWith('/api/auth/google/start')) return callback;
    start = next;
  }
}
