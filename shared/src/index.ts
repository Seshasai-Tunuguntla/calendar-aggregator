// The public surface of the shared package. Client and server import from
// '@calendar-aggregator/shared' only, never from files inside it. The slot algorithm has its own
// entry point, '@calendar-aggregator/shared/slots' (see src/slots/index.ts).
export * from './api/health.ts';
export * from './api/errors.ts';
export * from './api/availability.ts';
export * from './api/auth.ts';
export * from './time/localTime.ts';
