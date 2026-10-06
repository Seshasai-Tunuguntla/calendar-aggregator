import { describe, expect, it } from 'vitest';
import { DATABASE_MARGIN_MS, FUNCTION_MAX_DURATION_S, TIMEOUTS, worstCaseBookingMs } from '../../src/bookings/timeouts.ts';

describe('booking time limits', () => {
  it('let a Google call (after waiting for the lock) finish inside the booking transaction', () => {
    expect(TIMEOUTS.lockWaitMs + TIMEOUTS.googleCallMs + DATABASE_MARGIN_MS).toBeLessThanOrEqual(TIMEOUTS.transactionMs);
  });

  it("keep the worst-case booking request inside the API function's limit on Vercel", () => {
    // Read, wait for a connection and the lock, write, withdraw: 26 s plus database time.
    expect(worstCaseBookingMs(TIMEOUTS)).toBe(28_000);
    expect(worstCaseBookingMs(TIMEOUTS)).toBeLessThan(FUNCTION_MAX_DURATION_S * 1000);
    // Vercel's maximum on every plan with Fluid compute (checked October 2026).
    expect(FUNCTION_MAX_DURATION_S).toBeLessThanOrEqual(300);
  });
});
