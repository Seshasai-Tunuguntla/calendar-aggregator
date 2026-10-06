// The fixed codes the Google sign-in callback sends back (?error=, server/src/routes/googleAuth.ts),
// as messages a person can act on. Never text from Google.
const MESSAGES: Record<string, string> = {
  expired: 'That sign-in took too long or was opened in another browser. Please start again.',
  state_mismatch: "That sign-in link didn't come from this page, so it was ignored for your safety. Please start again.",
  access_denied: "You didn't give permission on Google's page, so nothing was connected.",
  calendar_permission_missing:
    "Calendar access is needed: on Google's page, keep all the calendar boxes ticked. Nothing was saved.",
  no_refresh_token: "Google didn't give lasting access. Please try again; if it keeps happening, remove the app at myaccount.google.com/permissions first.",
  email_in_use: 'Another account here already uses that email address.',
  account_in_use: 'That Google account is already connected to another user here.',
  signin_required: 'Please sign in first.',
  demo_cannot_connect: "The demo host can't connect a real Google account.",
  google_error: 'Google had a problem completing that. Please try again in a minute.',
};

export function signInErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? MESSAGES['google_error'] ?? null;
}

export const googleStartUrl = (params: Record<string, string>) => `/api/auth/google/start?${new URLSearchParams(params)}`;

/** The browser's IANA time zone, for a new account's working hours. */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
