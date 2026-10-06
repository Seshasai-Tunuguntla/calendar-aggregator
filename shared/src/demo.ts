// The public demo's booking page, which the sign-in page's "Try booking" opens. The server's demo
// data (server/src/demo/demoData.ts) uses the same handle and has this event type (tested there).
export const DEMO_HANDLE = 'priya';
export const DEMO_TRY_BOOKING_SLUG = '30-min-call';
export const DEMO_BOOKING_PATH = `/book/${DEMO_HANDLE}/${DEMO_TRY_BOOKING_SLUG}`;
