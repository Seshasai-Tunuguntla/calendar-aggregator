import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { vi } from 'vitest';
import type { SessionUser } from '@calendar-aggregator/shared';
import { AuthProvider } from '../../src/auth/AuthContext.tsx';
import { routes } from '../../src/router.tsx';

export const HOST: SessionUser = {
  id: '0190a5a4-0000-7000-8000-000000000001',
  name: 'Priya Sharma',
  email: 'priya@example.com',
  handle: 'priya',
  timeZone: 'Asia/Kolkata',
  isDemo: false,
};

export interface Call {
  method: string;
  url: string;
  body: unknown;
}

// A handler answers one API route: a Response, or anything else (sent as 200 JSON). Keys are
// 'METHOD /path' (the query string is ignored unless the key includes it).
type Handler = (call: Call) => unknown;

// Stubs fetch with the given routes and records every call. An unmocked route answers 500, so a
// test notices a request it didn't expect.
export function mockApi(handlers: Record<string, Handler | object>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const call = { method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const handler = handlers[`${method} ${url}`] ?? handlers[`${method} ${url.split('?')[0]}`];
      if (handler === undefined) return Response.json({ error: `No mock for ${method} ${url}` }, { status: 500 });
      const result = typeof handler === 'function' ? await (handler as Handler)(call) : handler;
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}

export const signedInAs = (user: SessionUser = HOST) => ({ 'GET /api/auth/me': { user } });
export const signedOut = { 'GET /api/auth/me': () => Response.json({ error: 'Not signed in' }, { status: 401 }) };

// The whole app (auth provider and real routes) in a memory router, starting at `path`.
export function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
  return router;
}

// A request that never answers, for loading states.
export const never = () => new Promise<never>(() => {});
export const failing = (status = 500, error = 'Something broke on our side') => () => Response.json({ error }, { status });
