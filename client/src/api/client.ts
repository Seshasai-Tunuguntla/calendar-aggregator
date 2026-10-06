import type { z } from 'zod';
import { apiErrorSchema } from '@calendar-aggregator/shared';

// An API call that failed. `message` is the server's client-safe error text when it sent one.
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

// GET a JSON endpoint and parse the response with the shared schema for it, so a server/client
// mismatch fails loudly here instead of as `undefined` somewhere in a component.
// `credentials: 'same-origin'` sends the session cookie (the API is always on our own origin).
export async function apiGet<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init?: { signal?: AbortSignal },
): Promise<z.infer<Schema>> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal: init?.signal ?? null,
  });
  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    throw new ApiRequestError(res.status, parsed.success ? parsed.data.error : `Request failed (${res.status})`);
  }
  return schema.parse(body);
}
