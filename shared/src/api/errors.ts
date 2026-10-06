import { z } from 'zod';

// Every error response from the API has this shape: a message that is safe to show the user, and
// for validation errors the individual issues.
export const apiErrorSchema = z.object({
  error: z.string(),
  details: z.array(z.unknown()).optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
