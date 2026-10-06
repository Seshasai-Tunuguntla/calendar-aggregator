import { z } from 'zod';

// DELETE /api/account. The user types their own handle, so a stray request can't delete an account.
export const deleteAccountRequestSchema = z.object({ confirmHandle: z.string() });
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

// revokedAtGoogle is false if any Google account couldn't be revoked (Google unreachable); the
// user can remove access at myaccount.google.com/permissions. eventsNotDeleted counts upcoming
// bookings whose calendar event couldn't be deleted (so those guests weren't told). The data is
// deleted either way.
export const deleteAccountResponseSchema = z.object({ revokedAtGoogle: z.boolean(), eventsNotDeleted: z.int().min(0) });
export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;
