# Calendar Aggregator: project brief and build plan

This file is the source of truth for the project's scope, decisions and progress, so that any
future work session can pick up from the repo alone. Update the **Status** table and the
**Decisions** sections whenever a phase lands.

## How we work

- One phase at a time. Each phase ends with a summary and a pause for review before the next starts.
- Briefly explain each decision. Code quality, tests, security and clear design decisions matter more than feature count.
- Every commit passes its own tests. Each approved phase is committed, pushed to `main`, and CI is confirmed green before moving on.
- Commit messages: imperative subject, a body explaining what and why.

## Goal

Users sign in with Google. The app reads their Google Calendars, combines their busy times, applies
their availability rules, and shows real free time. They share a booking link; a guest opens it,
picks a slot in their own time zone, and books it. The event is created on the host's Google
Calendar automatically, like a mini Calendly.

Third portfolio project for entry-level full-stack roles (after the Landlord Maintenance Tracker
and the Study Group Scheduler). Its main purpose is to show **OAuth done properly** and
**integration with a real external API** (Google Calendar), written in TypeScript. It follows the
Study Scheduler's conventions (error handler, `HttpError`, Zod validation, Postgres rate limiter,
test layout, mutation-checking tests, CI shape, this plan file, self-resetting demo, single Vercel
project + Neon) but must look visually different from both earlier projects.

## Stack

- **TypeScript everywhere**, strict mode (plus `noUncheckedIndexedAccess` and friends; see Phase 1 decisions)
- **npm workspaces monorepo:** `shared/` (Zod schemas, inferred types, pure functions), `server/`, `client/`
- **Frontend:** React (Vite) + react-router
- **Backend:** Node.js, Express 5, Prisma, PostgreSQL
- **Tests:** Vitest in all workspaces, Supertest for the API, Playwright for one end-to-end test
- **Time zones:** a proper library (Luxon or the Temporal polyfill; decided in phase 2)
- **Lint:** oxlint (same as the earlier projects), one config at the root
- **CI:** GitHub Actions: typecheck, lint, tests, build, e2e
- **Deploy:** one Vercel project (client + API function) with Neon Postgres
- **Local ports:** API 4200, web 5190 (so it can run next to Landlord 4000/5173 and Study Scheduler 4100/5180)

## Core features

1. Sign in with Google (OAuth). Sessions use an httpOnly, Secure, SameSite=Lax cookie, not a token in localStorage (explain the CSRF implications and how they're handled).
2. Choose which Google calendars count as "busy".
3. Optional: connect a second Google account (e.g. work + personal) and combine both.
4. Availability rules, in the host's time zone: weekly working hours, buffer before/after meetings, minimum notice (e.g. no bookings within 4 hours), how far ahead guests can book (e.g. 30 days), optional max bookings per day.
5. Event types (e.g. "15-min chat", "30-min call", "60-min session"), each with its own duration and public link: `/book/:handle/:eventTypeSlug`.
6. Public booking page: only free slots (never event titles or details), in the guest's local time zone; guest enters name + email and books.
7. On booking, the event is created on the host's Google Calendar with the guest as an attendee, so Google sends the invite.
8. Cancel/reschedule via a secret link given to the guest after booking.
9. Host dashboard: upcoming bookings, event types, rules, connection status with a clear "Reconnect Google" state when access expires or is revoked.
10. Self-resetting public demo.

## Architecture: the calendar provider interface

All calendar access goes through one interface:

- `listCalendars(connection)`
- `getBusyIntervals(connection, calendarIds, from, to)`
- `createEvent(connection, details)`
- `deleteEvent(connection, eventId)`

Two implementations:

- **GoogleCalendarProvider:** the real Google Calendar API
- **DemoCalendarProvider:** seeded fake busy events stored in our database

Tests and the public demo use the demo provider, so tests are fast and offline and the demo works
for visitors without Google access. Explained in the README.

## Why the demo can't use real Google sign-in

Until Google verifies the app it stays in "Testing" mode: only listed test users can sign in, and
their refresh tokens expire after about 7 days (exact current rules to be checked against Google's
docs in phase 4 and documented accurately). Recruiters must be able to try the app without that, so:

- **"Try as host"** logs into a demo host backed by DemoCalendarProvider
- **"Try booking"** opens the demo host's public booking page
- Real Google sign-in stays available for the author and test users

## OAuth requirements (the security centerpiece)

- Authorization code flow with **PKCE** and a random **`state`** stored in a short-lived, signed, httpOnly cookie; reject the callback if state doesn't match
- **Narrowest scopes** that work (check Google's current list): sign-in identity, reading free/busy and the calendar list, creating events. Each scope explained.
- **Verify the ID token** (issuer, audience, expiry) before trusting the user's identity
- **Offline access** for a refresh token; handle Google not returning one
- **Encrypt refresh tokens at rest** (AES-256-GCM, key from an env variable, key version stored alongside for rotation); never log tokens
- **Refresh access tokens automatically** before expiry; on `invalid_grant`, mark the connection "needs reconnect" and show it in the UI instead of crashing
- **Disconnect** = revoke the token at Google and delete it from our database

## The slot algorithm (built first, as pure functions)

**Inputs:** weekly rules (host time zone), busy intervals from all selected calendars, existing
bookings, buffers, minimum notice, booking horizon, event duration, slot step (e.g. every 15 or
30 minutes), "now".

**Process:**

1. Expand the weekly rules into concrete working intervals for each date in the horizon, in the host's time zone, converted to UTC. Correct across DST changes.
2. Merge all busy intervals (calendars + bookings), each expanded by the buffers (sort + merge, O(n log n)).
3. Subtract merged busy intervals from working intervals.
4. Slice the remaining free intervals into bookable slots of the event's duration, starting on the slot step.
5. Remove slots before now + minimum notice, and days that hit the max bookings per day.

**Required unit tests:**

- overlapping and touching busy intervals merge correctly
- buffers can block a slot that would otherwise fit
- an event that runs past the end of working hours is not offered
- minimum notice and booking horizon edges
- max bookings per day
- DST: working hours 09:00-17:00 in America/New_York on the actual March and November change dates produce correct UTC slots
- host in India, guest in New York: the same slot displays correctly for both
- empty calendars -> all working-hour slots; fully busy -> none
- a slow, obviously-correct reference implementation that the fast version must match on many random inputs

## Preventing double booking (second centerpiece)

1. **Database:** a Postgres exclusion constraint so one host can never have two overlapping active bookings (`tstzrange` + `btree_gist`). Prisma can't express this, so it's added to the migration by hand, with a check that later migrations don't drop it.
2. **Before confirming:** re-check the slot against fresh busy data from the provider, inside the booking flow.
3. If Google event creation fails after the booking is saved, roll back or mark the booking clearly (approach explained in phase 7).
4. Concurrency test: two simultaneous bookings of the same slot; exactly one succeeds, the other gets **409 "That time was just taken"**.

## Data model (Prisma, draft; refined and explained in phase 3)

- **User:** id, name, email (unique), handle (unique, for booking URLs), timeZone, isDemo, createdAt
- **CalendarConnection:** id, userId, provider (GOOGLE | DEMO), googleAccountEmail, encryptedRefreshToken, keyVersion, accessTokenExpiresAt, status (ACTIVE | NEEDS_RECONNECT), createdAt
- **SelectedCalendar:** id, connectionId, externalCalendarId, name, countsAsBusy
- **AvailabilityRule:** id, userId, weekday, startMinute, endMinute (host local time)
- **Settings** (on User or a separate table): bufferBefore, bufferAfter, minNoticeMinutes, horizonDays, maxPerDay
- **EventType:** id, userId, slug (unique per user), title, durationMinutes, slotStepMinutes, active
- **Booking:** id, eventTypeId, hostId, guestName, guestEmail, startsAt, endsAt (UTC), status (CONFIRMED | CANCELLED), externalEventId, manageTokenHash, createdAt
- **DemoBusyEvent:** id, userId, startsAt, endsAt (for the demo provider)
- **RateLimit** table (reuse the Study Scheduler pattern)

## API routes (draft)

### Auth / Google
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/google/start` | redirect to Google (sets state + PKCE cookie) |
| GET | `/api/auth/google/callback` | exchange code, verify ID token, create session |
| POST | `/api/auth/demo` | one-click demo host login |
| GET | `/api/auth/me` | current user |
| POST | `/api/auth/logout` | end session |
| DELETE | `/api/connections/:id` | disconnect (revoke at Google) |

### Host (logged in)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/calendars` | calendars across connections |
| PATCH | `/api/calendars/:id` | `{ countsAsBusy }` |
| GET / PUT | `/api/availability` | rules + settings |
| GET / POST / PATCH / DELETE | `/api/event-types` | manage event types |
| GET | `/api/bookings` | upcoming, paged |
| POST | `/api/bookings/:id/cancel` | host cancels |

### Public (no login, rate limited)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/public/:handle/:slug` | event type info (no private data) |
| GET | `/api/public/:handle/:slug/slots?from=&to=&tz=` | free slots |
| POST | `/api/public/:handle/:slug/bookings` | `{ start, guestName, guestEmail, guestTimeZone }` |
| GET | `/api/public/bookings/:token` | guest views their booking |
| POST | `/api/public/bookings/:token/cancel` | guest cancels |
| POST | `/api/public/bookings/:token/reschedule` | guest reschedules |

## Privacy rules

- Public pages show free slots only: never event titles, attendees, or calendar names
- Don't store Google event contents; busy intervals only, cached briefly if at all
- Guest emails visible only to the host
- Manage links use a random token; only its hash is stored

## Frontend pages

- `/login`: "Sign in with Google", "Try as host", "Try booking"
- `/dashboard`: upcoming bookings, connection status, quick links to share
- `/calendars`: choose which calendars count as busy, connect a second account
- `/availability`: weekly hours editor + buffers/notice/horizon settings, with a live preview of next week's free slots
- `/event-types`: list, create, edit, copy link
- `/book/:handle/:slug`: public page; date picker, slots in the guest's local time zone, booking form, confirmation screen with the manage link
- `/booking/:token`: guest view, cancel, reschedule
- Loading, empty and error states everywhere; works at 375 px; keyboard accessible

## Demo design (what recruiters see)

- Demo host "Priya" in India with a realistic week of fake busy events, working hours, buffers, and 2-3 event types
- One-click "Try as host" and "Try booking" buttons
- Visitors can book the demo host; bookings and fake events go through the demo provider
- Self-resetting with the Study Scheduler's protections: reset time stored in the database, 30-minute rule on cold starts and demo logins, a lock so only one rebuild runs, stable ids, demo accounts can't connect real Google accounts, everything a visitor can change is restored on reset
- Busy events regenerated relative to "today" on each reset, so the demo never shows an empty or out-of-date week

## Out of scope for now

Outlook/Apple calendars, payments, team or round-robin scheduling, recurring bookings, our own
email sending (Google's invites cover it), Google push-notification webhooks (possible stretch
goal; trade-off vs short caching to be explained).

## Build order and status

| # | Phase | Status |
|---|---|---|
| 1 | Scaffold the TypeScript monorepo (client, server, shared), strict mode, lint, Vitest, CI with typecheck; this plan | Done |
| 2 | Slot algorithm as pure functions, all required tests + reference implementation (approach explained first) | |
| 3 | Prisma schema + migrations (incl. exclusion constraint), CalendarProvider interface, DemoCalendarProvider, demo host login, session cookies | |
| 4 | Google OAuth: setup instructions, start/callback, PKCE, state, ID token verification, encrypted refresh tokens, refresh handling, disconnect; Google mocked in tests | |
| 5 | GoogleCalendarProvider: list calendars, busy intervals, create/delete events, error handling, mocked-API tests | |
| 6 | Availability rules, settings, event types, slots endpoint | |
| 7 | Public booking: double-booking protection, Google event creation, manage token, cancel, reschedule, concurrency tests | |
| 8 | Design: 3 mockups (desktop + 375 px) with pros/cons, author picks one; host frontend through shared design tokens | |
| 9 | Public booking frontend (guest flow end to end) | |
| 10 | Self-resetting demo + tests | |
| 11 | README for recruiters (diagrams, decisions, trade-offs, screenshots), Playwright smoke test | |
| 12 | Deploy to Vercel + Neon (previews never touch production DB), production redirect URIs, live link, real-phone test | |

## Phase 1 decisions (scaffold)

- **npm workspaces, one lockfile, one install.** `shared` is a normal dependency of `client` and `server` (`"@calendar-aggregator/shared": "*"`), linked by npm. Its `package.json` `exports` points straight at `src/index.ts`, so there is no build step for it: Vite compiles it for the client and Node runs it for the server.
- **The server runs TypeScript directly with Node's built-in type stripping** (`node src/server.ts`), instead of `tsx` or a `tsc` build. Fewer moving parts, and stack traces point at the real source lines. The cost is that only *erasable* syntax is allowed (no `enum`, `namespace` or constructor parameter properties) and relative imports must end in `.ts`; `erasableSyntaxOnly`, `verbatimModuleSyntax` and `allowImportingTsExtensions` make `tsc` enforce exactly that. Enums are replaced by `as const` objects or Zod enums, which we want anyway for validation. `tsc` only typechecks (`noEmit`).
- **Strictness beyond `strict`:** `noUncheckedIndexedAccess` (array/record reads may be `undefined`, important for the interval code in phase 2), `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature` (so `process.env['X']` reads visibly as "may be missing"). Verified with a probe file: an unchecked `xs[0]` and an `enum` both fail the typecheck.
- **TypeScript 7** (the native Go compiler, current release). Typechecks the whole repo in well under a second. Nothing here depends on the old JS compiler API.
- **Node 24 LTS** in CI and `engines`. (The author's machine has Node 25, an odd, non-LTS release; it works, but jsdom warns about it. Switching locally to 24 is recommended, not required.)
- **No CORS on the API, on purpose.** The browser only ever calls the API on its own origin: Vite proxies `/api` to port 4200 in development, and one Vercel project serves both in production. This keeps the session cookie first-party (needed for SameSite=Lax in phase 3) and removes a whole class of misconfiguration. A test asserts no `Access-Control-Allow-Origin` header is sent.
- **Error handling ported from the Study Scheduler:** `HttpError` + one central handler (Zod -> 400 with the first message and all issues, malformed JSON -> 400, client-safe 4xx passed through, everything else a generic 500 that never leaks the message). The Prisma branch (P2002 -> 409, P2025 -> 404) returns in phase 3 with Prisma. One test per branch, so removing any branch fails exactly one test.
- **Shared response schemas, checked on both sides.** The server's tests parse responses with the shared Zod schema; the client's `apiGet(path, schema)` parses every response with it too, so a mismatch fails loudly at the boundary instead of as `undefined` in a component. The health endpoint is the first example.
- **oxlint at the root** (one config for all workspaces) with the `typescript`, `react`, `import`, `unicorn` and `vitest` plugins; correctness rules are errors. Typecheck is a separate CI step, so lint stays fast.
- **Vitest everywhere**, replacing Jest from the earlier projects: it understands TypeScript and ESM natively and shares Vite's config on the client. Server tests keep the earlier layout: `tests/unit` (no database) and `tests/api` (Supertest). Client tests run in jsdom with Testing Library.
- **CI: one job for now** (`npm ci`, typecheck, lint, test, build) on Node 24. The Postgres service joins in phase 3 and the Playwright job in phase 11. `npm ci` works here (the Study Scheduler needed `npm install`) because npm 11's lockfile records the Linux builds of oxlint and rolldown.

## Notes for later phases

- **Phase 2:** decide Luxon vs the Temporal polyfill (Node 25 has no built-in `Temporal` yet).
- **Phase 3:** decide the Prisma major version (the Study Scheduler pinned 6; check what 7+ needs with ESM + type stripping and on Vercel).
- **Phase 4:** check Google's current testing-mode rules (test-user limit, refresh-token lifetime) and current scope list before documenting them.
- **Client bundle** is ~390 kB before gzip, mostly Zod and react-router; revisit (e.g. `zod/mini` on the client) once real pages exist.
