import { z } from 'zod';

// The signed-in host, as the API returns it. Tokens, connections and settings are never part of it.
export const sessionUserSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  handle: z.string(),
  timeZone: z.string(),
  isDemo: z.boolean(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

// GET /api/auth/me and POST /api/auth/demo.
export const meResponseSchema = z.object({ user: sessionUserSchema });

export type MeResponse = z.infer<typeof meResponseSchema>;
