// Every time limit on the way from a guest's "Book" click to Google and back, in one place, so
// they can be checked against each other (tests/unit/timeouts.test.ts).
//
// Worst case for one booking request: a free/busy read (one Google call), waiting for a pooled
// database connection, waiting for the host's lock, creating the event (one Google call), and,
// if that failed after Google may have acted, withdrawing it (one more). With the values below
// that's 6 + 3 + 5 + 6 + 6 = 26 seconds plus a little database time: under the 60 seconds the API
// function is allowed on Vercel (set in phase 12; Vercel's own limit with Fluid compute is 300 s
// on every plan, checked October 2026).
export interface Timeouts {
  /** One Google Calendar call, including its retries and any token refresh it needs. */
  googleCallMs: number;
  /** Waiting for a pooled database connection to start the booking transaction (Prisma's maxWait). */
  connectionWaitMs: number;
  /** Waiting for another booking change of the same host to finish (Postgres lock_timeout). */
  lockWaitMs: number;
  /** The whole booking transaction (Prisma's interactive transaction timeout). */
  transactionMs: number;
}

export const TIMEOUTS: Timeouts = {
  googleCallMs: 6_000,
  connectionWaitMs: 3_000,
  lockWaitMs: 5_000,
  transactionMs: 15_000,
};

// The API function's maximum duration on Vercel (vercel.json, phase 12).
export const FUNCTION_MAX_DURATION_S = 60;

// Database work inside a booking transaction besides the lock and the Google call: a few short
// queries. Generous on purpose.
export const DATABASE_MARGIN_MS = 2_000;

export function worstCaseBookingMs(t: Timeouts): number {
  return 3 * t.googleCallMs + t.connectionWaitMs + t.lockWaitMs + DATABASE_MARGIN_MS;
}
