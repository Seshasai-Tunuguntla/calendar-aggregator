import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { healthResponseSchema } from '@calendar-aggregator/shared';
import { ApiRequestError, SESSION_ENDED_EVENT, apiGet, apiSend } from '../../src/api/client.ts';

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('apiGet', () => {
  it('returns the parsed body and sends same-origin credentials', async () => {
    const fetchMock = stubFetch(200, { status: 'ok' });
    await expect(apiGet('/api/health', healthResponseSchema)).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it("throws the server's error message with its status", async () => {
    stubFetch(409, { error: 'That time was just taken' });
    const error = await apiGet('/api/x', healthResponseSchema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 409, message: 'That time was just taken' });
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    stubFetch(502, '<html>Bad gateway</html>');
    await expect(apiGet('/api/x', healthResponseSchema)).rejects.toMatchObject({
      status: 502,
      message: 'Something went wrong (502). Please try again.',
    });
  });

  it('rejects a success response that does not match the schema', async () => {
    stubFetch(200, { status: 'maybe' });
    await expect(apiGet('/api/health', healthResponseSchema)).rejects.toBeInstanceOf(ZodError);
  });
});

describe('apiSend', () => {
  it('sends a JSON body with the method and parses the answer', async () => {
    const fetchMock = stubFetch(200, { status: 'ok' });
    await expect(apiSend('PUT', '/api/x', { a: 1 }, healthResponseSchema)).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/x',
      expect.objectContaining({ method: 'PUT', body: '{"a":1}', credentials: 'same-origin', headers: expect.objectContaining({ 'Content-Type': 'application/json' }) }),
    );
  });

  it('accepts an empty 204 answer', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiSend('POST', '/api/auth/logout')).resolves.toBeNull();
  });

  it("says the server can't be reached when the network fails", async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiSend('POST', '/api/x')).rejects.toMatchObject({ status: 0, message: "Can't reach the server. Check your connection and try again." });
  });

  it('announces that the session ended when the API answers 401', async () => {
    stubFetch(401, { error: 'Not signed in' });
    const ended = vi.fn<() => void>();
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    await apiSend('POST', '/api/x').catch(() => {});
    window.removeEventListener(SESSION_ENDED_EVENT, ended);
    expect(ended).toHaveBeenCalledOnce();
  });
});
