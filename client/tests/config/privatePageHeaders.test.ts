import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { PRIVATE_PAGE_HEADERS } from '../../src/guest/privatePage.ts';
import { privatePageHeaders } from '../../vite.config.ts';

// Manage pages put the booking's secret token in the URL. These headers keep it out of the Referer
// sent to other sites and out of search engines, for the page itself (not just its API calls).
function headersFor(url: string): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  const res = { setHeader: (name: string, value: unknown) => (headers[name] = value) } as unknown as ServerResponse;
  let calledNext = false;
  privatePageHeaders({ url } as IncomingMessage, res, () => (calledNext = true));
  expect(calledNext).toBe(true);
  return headers;
}

describe('manage page headers', () => {
  it('are sent with /booking/<token> pages in development and preview', () => {
    expect(headersFor(`/booking/${'A'.repeat(43)}`)).toEqual({ 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
  });

  it("aren't added to other pages, such as the public booking page", () => {
    expect(headersFor('/book/priya/30-min-call')).toEqual({});
    expect(headersFor('/dashboard')).toEqual({});
  });

  it('match what vercel.json sends in production', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), '../vercel.json'), 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
    const rule = vercel.headers.find((h) => h.source === '/booking/:token');
    expect(Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]))).toEqual(PRIVATE_PAGE_HEADERS);
  });
});
