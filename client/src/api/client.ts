import type { z } from 'zod';
import { apiErrorSchema } from '@calendar-aggregator/shared';

// An API call that failed. `message` is the server's client-safe error text when it sent one, so
// pages can show it as is ("That time was just taken", "Reconnect …").
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

// Fired when the API answers 401: the session ended (expired, or signed out elsewhere). The auth
// provider listens and sends the host to the sign-in page.
export const SESSION_ENDED_EVENT = 'calendar-aggregator:session-ended';

async function request(path: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, credentials: 'same-origin', headers: { Accept: 'application/json', ...init.headers } });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiRequestError(0, "Can't reach the server. Check your connection and try again.");
  }
  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
    const parsed = apiErrorSchema.safeParse(body);
    throw new ApiRequestError(res.status, parsed.success ? parsed.data.error : `Something went wrong (${res.status}). Please try again.`);
  }
  return body;
}

// GET a JSON endpoint and parse the response with the shared schema for it, so a server/client
// mismatch fails loudly here instead of as `undefined` somewhere in a component.
// `credentials: 'same-origin'` sends the session cookie (the API is always on our own origin).
export async function apiGet<Schema extends z.ZodType>(path: string, schema: Schema, init?: { signal?: AbortSignal }): Promise<z.infer<Schema>> {
  return schema.parse(await request(path, { signal: init?.signal ?? null }));
}

// A change (POST, PUT, PATCH, DELETE) with a JSON body. The browser adds the Origin header the
// API's CSRF check needs. With a schema, the response is parsed with it; without, it's ignored.
export async function apiSend<Schema extends z.ZodType>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  schema?: Schema,
): Promise<z.infer<Schema>> {
  const result = await request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
  return (schema ? schema.parse(result) : result) as z.infer<Schema>;
}

// The message to show for any error a call can throw.
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'Something went wrong. Please try again.';
}
