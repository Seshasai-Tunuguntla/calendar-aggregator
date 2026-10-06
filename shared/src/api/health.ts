import { z } from 'zod';

// GET /api/health. The server validates its own response against this schema in tests, and the
// client parses the response with it, so both sides agree on the shape at compile time and run time.
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
