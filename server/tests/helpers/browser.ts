import request from 'supertest';
import type { Express } from 'express';
import { TEST_HOST } from './http.ts';

// A tiny browser for API tests: keeps cookies between requests (adding and clearing them from
// Set-Cookie headers) and sends Origin on state-changing requests, like a real browser on our site.
export class TestBrowser {
  readonly cookies = new Map<string, string>();
  readonly #app: Express;

  constructor(app: Express) {
    this.#app = app;
  }

  get(path: string) {
    return this.#send(request(this.#app).get(path));
  }

  post(path: string, body?: object) {
    return this.#send(request(this.#app).post(path).set('Origin', `http://${TEST_HOST}`), body);
  }

  put(path: string, body: object) {
    return this.#send(request(this.#app).put(path).set('Origin', `http://${TEST_HOST}`), body);
  }

  patch(path: string, body: object) {
    return this.#send(request(this.#app).patch(path).set('Origin', `http://${TEST_HOST}`), body);
  }

  delete(path: string, body?: object) {
    return this.#send(request(this.#app).delete(path).set('Origin', `http://${TEST_HOST}`), body);
  }

  async #send(req: request.Test, body?: object): Promise<request.Response> {
    req.set('Host', TEST_HOST);
    if (this.cookies.size > 0) req.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (body !== undefined) req.send(body);
    const res = await req;
    for (const header of [res.headers['set-cookie'] ?? []].flat() as string[]) {
      const [pair = ''] = header.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
}
