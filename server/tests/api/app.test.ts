import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@calendar-aggregator/shared';
import { createApp } from '../../src/app.ts';

describe('GET /api/health', () => {
  it('answers with the shape the shared schema describes', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(res.body)).toEqual({ status: 'ok' });
  });
});

describe('app-wide middleware', () => {
  it('sets security headers and hides the framework', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sends no CORS headers: the API is same-origin only', async () => {
    const res = await request(createApp()).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const res = await request(createApp()).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});
