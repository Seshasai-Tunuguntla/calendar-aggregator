import type { Test } from 'supertest';

export const TEST_HOST = 'calendar.test';

// A request as our own pages send it: browsers always add Origin to POST/PUT/PATCH/DELETE, and on
// our site it names the same host the request goes to. requireSameOrigin rejects anything else.
export function fromOurPage(req: Test): Test {
  return req.set('Host', TEST_HOST).set('Origin', `http://${TEST_HOST}`);
}
