import { describe, expect, it } from 'vitest';
import { apiErrorSchema, healthResponseSchema } from '../src/index.ts';

describe('healthResponseSchema', () => {
  it('accepts the health response', () => {
    expect(healthResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
  });

  it('rejects any other status', () => {
    expect(healthResponseSchema.safeParse({ status: 'down' }).success).toBe(false);
  });
});

describe('apiErrorSchema', () => {
  it('accepts an error with and without details', () => {
    expect(apiErrorSchema.safeParse({ error: 'Not found' }).success).toBe(true);
    expect(apiErrorSchema.safeParse({ error: 'Bad input', details: [{ path: ['x'] }] }).success).toBe(true);
  });

  it('rejects a response without a message', () => {
    expect(apiErrorSchema.safeParse({ details: [] }).success).toBe(false);
  });
});
