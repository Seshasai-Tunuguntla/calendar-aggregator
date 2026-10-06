import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { apiErrorSchema } from '@calendar-aggregator/shared';
import { errorHandler, notFound } from '../../src/middleware/errorHandler.ts';
import { HttpError } from '../../src/utils/httpError.ts';

// A tiny app whose routes throw each kind of error the handler knows about. Each branch of the
// handler has its own test, so removing or breaking any branch makes exactly one test fail.
function appThatThrows() {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.get('/http-error', () => {
    throw new HttpError(409, 'That time was just taken');
  });
  app.get('/http-error-503', () => {
    throw new HttpError(503, "Can't check your calendar right now");
  });
  app.get('/zod-error', () => {
    z.object({ email: z.email('Enter a valid email') }).parse({ email: 'nope' });
  });
  app.get('/async-error', async () => {
    await Promise.resolve();
    throw new HttpError(403, 'Not yours');
  });
  app.get('/server-error', () => {
    throw new Error('database password is hunter2');
  });
  app.get('/exposed-5xx', () => {
    throw Object.assign(new Error('upstream detail'), { status: 502, expose: true });
  });
  app.get('/prisma-unique', () => {
    throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['handle'] },
    });
  });
  app.get('/prisma-not-found', () => {
    throw new Prisma.PrismaClientKnownRequestError('Record to update not found', { code: 'P2025', clientVersion: 'test' });
  });
  app.get('/prisma-other', () => {
    throw new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', { code: 'P2003', clientVersion: 'test' });
  });
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns an HttpError into its status and message', async () => {
    const res = await request(appThatThrows()).get('/http-error');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'That time was just taken' });
  });

  it("passes an HttpError's 503 and message through (\"try again later\" must reach the user)", async () => {
    const res = await request(appThatThrows()).get('/http-error-503');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Can't check your calendar right now" });
  });

  it('catches errors thrown from async handlers (Express 5)', async () => {
    const res = await request(appThatThrows()).get('/async-error');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Not yours' });
  });

  it('turns a ZodError into 400 with the first message and all issues', async () => {
    const res = await request(appThatThrows()).get('/zod-error');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Enter a valid email');
    expect(res.body.details).toHaveLength(1);
    expect(apiErrorSchema.safeParse(res.body).success).toBe(true);
  });

  it('turns a Prisma unique violation (P2002) into 409 naming the field', async () => {
    const res = await request(appThatThrows()).get('/prisma-unique');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'handle already in use' });
  });

  it('turns a Prisma "record not found" (P2025) into 404', async () => {
    const res = await request(appThatThrows()).get('/prisma-not-found');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Record not found' });
  });

  it('treats other Prisma errors as unexpected (500)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThatThrows()).get('/prisma-other');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('answers malformed JSON with 400 instead of 500', async () => {
    const res = await request(appThatThrows())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Request body is not valid JSON' });
  });

  it('passes through other client-safe 4xx errors such as payload too large', async () => {
    const res = await request(appThatThrows())
      .post('/echo')
      .send({ text: 'x'.repeat(2000) });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('hides the message of unexpected errors behind a generic 500', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThatThrows()).get('/server-error');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(log).toHaveBeenCalledOnce();
  });

  it('never exposes the message of a 5xx, even when it is marked exposable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThatThrows()).get('/exposed-5xx');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('answers unknown routes with a JSON 404', async () => {
    const res = await request(appThatThrows()).get('/nowhere');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});
