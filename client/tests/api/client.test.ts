import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { healthResponseSchema } from '@calendar-aggregator/shared';
import { ApiRequestError, apiGet } from '../../src/api/client.ts';

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
      message: 'Request failed (502)',
    });
  });

  it('rejects a success response that does not match the schema', async () => {
    stubFetch(200, { status: 'maybe' });
    await expect(apiGet('/api/health', healthResponseSchema)).rejects.toBeInstanceOf(ZodError);
  });
});
