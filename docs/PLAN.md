# Calendar Aggregator: project brief and build plan

This file is the source of truth for the project's scope, decisions and progress, so that any
future work session can pick up from the repo alone. Update the **Status** table and the
**Decisions** sections whenever a phase lands.

## How we work

- One phase at a time. Each phase ends with a summary and a pause for review before the next starts.
- Briefly explain each decision. Code quality, tests, security and clear design decisions matter more than feature count.
- Every commit passes its own tests. Each approved phase is committed, pushed to `main`, and CI is confirmed green before moving on.
- A git pre-push hook (`.githooks/pre-push`, installed by `npm install`) runs the same checks as CI and blocks a failing push; no force-pushes to `main`. See README, "Development".
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
11. Delete my account: revoke Google access, delete all of the user's data, end the session (backend in phase 6, UI in phase 8).

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

Until Google verifies the app it stays in "Testing" mode (checked against Google's docs in October
2026; details and sources in docs/google-setup.md): only listed test users can sign in (up to
100), and because the app asks for Calendar scopes (not just name, email and profile), their
refresh tokens expire after 7 days. Publishing with the sensitive `calendar.events.owned` scope
would need Google's verification (privacy policy and home page on an owned domain, and a review).
Recruiters must be able to try the app without any of that, so:

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

**Worked example** (also a unit test). Host Priya in `Asia/Kolkata`, Monday 12 Oct 2026, working
hours 09:00-13:00, 15-minute buffers before and after, 30-minute event, 30-minute slot step, 4-hour
minimum notice, now = 08:00. Busy: A 09:30-10:00, B 09:45-10:30, C 11:30-12:00 (all IST).

| Step | What happens | Result |
|---|---|---|
| 1. Expand rules | Mon 09:00-13:00 IST becomes 03:30-07:30 UTC | working: 09:00-13:00 |
| 2. Buffer + merge | Each busy interval grows 15 min each side: A 09:15-10:15, B 09:30-10:45, C 11:15-12:15; sort, merge overlapping/touching | busy: 09:15-10:45, 11:15-12:15 |
| 3. Subtract | working minus busy | free: 09:00-09:15, 10:45-11:15, 12:15-13:00 |
| 4. Slice | candidate starts every 30 min from 09:00; keep those whose whole 30 min fit in a free interval | 09:00 no (free ends 09:15); 10:45-11:15 is 30 min long but 10:45 isn't on the grid and 11:00-11:30 overruns; 12:30 yes |
| 5. Filter | earliest start = 08:00 + 4 h = 12:00; max per day not reached | **12:30-13:00 IST only** |

12:30 IST is 07:00 UTC, which a guest in New York sees as 03:00 EDT (New York leaves DST on 1 Nov 2026).

Buffers on vs off: without buffers the free time is 09:00-09:30, 10:30-11:30 and 12:00-13:00, so
step 4 gives 09:00, 10:30, 11:00, 12:00 and 12:30. The 4-hour minimum notice then removes 09:00,
10:30 and 11:00, so turning buffers off adds **only 12:00**.

**Approved details:**

- **Times inside the algorithm are plain numbers** (UTC epoch milliseconds). The time-zone library is used only in step 1 (local rules -> UTC) and to find which host-local day a slot falls on.
- **Slot grid:** candidate starts are the working interval's start plus whole steps, counted in real elapsed minutes. For normal rules that's 09:00, 09:30...; it stays well-defined on DST change days. Each rule's own interval anchors its grid (see Phase 2 decisions for why not the merged interval).
- **DST:** each working interval's start and end are converted separately, so the real length is right on change days (e.g. 09:00 New York is 13:00 UTC on 8 Mar 2026 and 14:00 UTC on 1 Nov 2026). A rule time that doesn't exist (spring-forward gap) moves later, Temporal's `compatible` behaviour.
- **Asymmetric buffers:** a new slot [s, e) needs [s - bufferBefore, e + bufferAfter) clear, so a busy interval [b0, b1) is expanded to **[b0 - bufferAfter, b1 + bufferBefore)**. Working-hour edges are not shrunk by buffers.
- **Horizon:** a slot is offered only if it starts no later than now + horizonDays.
- **Max per day:** counts confirmed bookings on the host's local day; a day at the limit offers nothing.
- **Reference implementation:** checks every grid start directly, minute by minute, with no merging or subtraction; the fast version must match it on hundreds of random inputs from a fixed seed (so failures reproduce).

## Preventing double booking (second centerpiece)

1. **Database:** a Postgres exclusion constraint so one host can never have two overlapping active bookings (`tstzrange` + `btree_gist`). Prisma can't express this, so it's added to the migration by hand, with a check that later migrations don't drop it.
2. **Before confirming:** re-check the slot against fresh busy data from the provider, inside the booking flow.
3. If Google event creation fails after the booking is saved, roll back or mark the booking clearly (approach explained in phase 7).
4. Concurrency test: two simultaneous bookings of the same slot; exactly one succeeds, the other gets **409 "That time was just taken"**.

## Data model (Prisma, draft; see "Phase 3 decisions" for the refined model)

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
| POST | `/api/calendars/sync` | copy the calendar lists again and re-check access (phase 6) |
| PATCH | `/api/calendars/:id` | `{ countsAsBusy }` |
| PUT | `/api/calendars/booking-calendar` | `{ calendarId }`: where booking events go (phase 7) |
| GET / PUT | `/api/availability` | rules + settings |
| GET / POST / PATCH / DELETE | `/api/event-types` | manage event types |
| GET | `/api/bookings` | upcoming, paged |
| POST | `/api/bookings/:id/cancel` | host cancels |
| DELETE | `/api/account` | delete my account and all my data (see "Delete my account") |

### Public (no login, rate limited)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/public/book/:handle/:slug` | event type info (no private data); under `/book/` since phase 6 |
| GET | `/api/public/book/:handle/:slug/slots?from=&to=&tz=` | free slots |
| POST | `/api/public/book/:handle/:slug/bookings` | `{ start, guestName, guestEmail, guestTimeZone }` |
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

## Delete my account

Added after the phase 4 review. Backend in phase 6, UI in phase 8.

**`DELETE /api/account`**, body `{ confirmHandle }` (the user's own handle, so a stray request can't delete an account; the UI asks them to type it):

1. **Refuse the demo host** (403): visitors can't delete the shared demo.
2. **Cancel upcoming confirmed bookings** by deleting their events through the provider with `sendUpdates=all`, so Google tells each guest the meeting is off. Best effort: a failure is logged, not fatal.
3. **Revoke Google access** for every Google connection (best effort, like disconnect: Google unreachable still deletes our copy).
4. **Delete everything that belongs to the user in one transaction:** bookings (past ones too: guest names and emails are personal data), event types, availability rules, calendars, connections and their encrypted tokens, sessions, and the user. Bookings are deleted explicitly first because they restrict event type deletion (phase 3).
5. **End the session:** clear the cookie, answer 204.

**Tests:** every table is empty of the user's rows and other users' rows are untouched; refresh tokens are revoked at the fake Google; guests' events are deleted; the old session token stops working; a wrong `confirmHandle` changes nothing; the demo host gets 403; Google being unreachable still deletes the data (and the response says revocation failed); the request needs `Origin` (CSRF); signing in with the same Google account afterwards creates a fresh, empty user.

## Design rule

This project must look **clearly different from both earlier projects**:

- **Avoid the Landlord Maintenance Tracker look:** light utility style, hazard tape, key tag.
- **Avoid the Study Scheduler look:** dark slate + amber, top bar/sidebar layout, heatmap-grid hero.

Phase 8 mockup directions (each shown at desktop and 375 px, with pros/cons):

1. **Editorial:** cream + deep green, large headings.
2. **Bold neo-brutalist:** thick black borders, yellow/blue blocks.
3. **Soft product:** pale blue/lilac, a centred booking card.

**The public booking page is the priority screen**: it's what a guest (and a recruiter clicking
"Try booking") sees first, so it gets designed first and most carefully.

## Out of scope for now

Outlook/Apple calendars, payments, team or round-robin scheduling, recurring bookings, our own
email sending (Google's invites cover it), Google push-notification webhooks (possible stretch
goal; trade-off vs short caching to be explained).

## Build order and status

| # | Phase | Status |
|---|---|---|
| 1 | Scaffold the TypeScript monorepo (client, server, shared), strict mode, lint, Vitest, CI with typecheck; this plan | Done |
| 2 | Slot algorithm as pure functions, all required tests + reference implementation (approach explained first) | Done |
| 3 | Prisma schema + migrations (incl. exclusion constraint), CalendarProvider interface, DemoCalendarProvider, demo host login, session cookies | Done |
| 4 | Google OAuth: setup instructions, start/callback, PKCE, state, ID token verification, encrypted refresh tokens, refresh handling, disconnect; Google mocked in tests | Done |
| 5 | GoogleCalendarProvider: list calendars, busy intervals, create/delete events, error handling, mocked-API tests | Done |
| 6 | Availability rules, settings, event types, slots endpoint; "Delete my account" backend | Done |
| 7 | Public booking: double-booking protection, Google event creation, manage token, cancel, reschedule, concurrency tests | Done |
| 8 | Design: 3 mockups (desktop + 375 px) with pros/cons, author picks one; host frontend through shared design tokens (incl. "Delete my account") | Done |
| 9 | Public booking frontend (guest flow end to end) | Done |
| 10 | Self-resetting demo + tests | Done |
| 11 | README for recruiters (diagrams, decisions, trade-offs, screenshots), Playwright smoke test | Done |
| 12 | Deploy to Vercel + Neon (previews never touch production DB), production redirect URIs, live link, real-phone test | Done, except the steps that need the author (see the Phase 12 checklist) |

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

## Phase 2 decisions (slot algorithm)

- **Where it lives:** `shared/src/slots/` (`intervals.ts`, `weeklyRules.ts`, `computeSlots.ts`), published as a separate entry point, `@calendar-aggregator/shared/slots`. The main `@calendar-aggregator/shared` entry stays free of Temporal.
- **Temporal stays off the client.** Measured with rolldown (Vite's bundler): the polyfill is 58 kB minified / **19 kB gzipped**, about +16% on the current client. The client doesn't need it: showing a slot in the guest's zone and grouping slots by the guest's date work with `Intl`, through `localParts(epochMs, timeZone)` in the main shared entry. A client lint rule (`no-restricted-imports`) rejects importing `temporal-polyfill` or `shared/slots`. The client gets slots from the API.
- **Temporal is imported, not installed globally** (`import { Temporal } from 'temporal-polyfill'`), so nothing patches `globalThis` and the code keeps working unchanged when Node ships Temporal.
- **Grid anchor (refines the approved detail):** each rule's own interval anchors its grid, not the merged working interval. If anchors came from merged intervals, rules that touch across days (e.g. 24-hour availability) would merge into one long interval whose start depends on how far back the request looked, so the grid could shift between two requests for the same week. Per-rule anchors keep the grid fixed. A slot can still run across two adjacent rules (09:00-12:00 + 12:00-14:00 offers 11:30-12:30), because fit is checked against the merged free time. Overlapping rules can produce the same start twice; it's listed once.
- **Step 4 checks grid starts against free time** (binary search per start) instead of slicing each free interval. Same result, and it handles several anchors per day cleanly. Notice and horizon bound which starts are generated at all (step 5's first half), so out-of-window slots are never built. Total: O(n log n + c log f) for n busy intervals, c grid starts in the window, f free intervals.
- **Weekdays use ISO numbering** (1 = Monday ... 7 = Sunday), matching Temporal's `dayOfWeek`. The Prisma model in phase 3 uses the same.
- **Horizon is in real 24-hour days** from now (so across a DST change it's an hour longer or shorter in local terms). Simple, and invisible at a 30-day horizon.
- **The pure function checks its own inputs** (positive integer duration and step, non-negative buffers/notice/horizon, `maxPerDay` null or >= 1, valid rules) and throws `RangeError`. The API validates with Zod first (phase 6); this keeps the function safe anywhere, e.g. a zero step would loop forever.
- **Tests (73 in `shared`):** every required case, plus asymmetric buffers each way, grid anchoring, adjacent and overlapping rules, range filtering, and notice/horizon edges to the millisecond. The worked example and its buffers-on/off variant are tests.
- **Reference implementation** (`tests/slots/reference.ts`): minute-by-minute with sets, no merging/subtraction/binary search, buffers written from the slot's side. Compared with the fast version on **400 seeded random requests** in 8 zones chosen for awkward cases (Lord Howe's 30-minute DST, Kathmandu/Chatham's 45-minute offsets, Santiago's midnight changes). "Now" is usually placed just before the chosen zone's next real DST change, found with Temporal rather than hard-coded. A guard stops the test passing vacuously: >8,000 slots in total, fewer than a third of requests empty, more than 40 that cross a DST change with slots, and buffers and the daily limit each changing the result in many cases. The first version of the generator failed this guard (54% empty, only 14 DST crossings) and was fixed.
- **Independent check of the time-zone code:** the reference shares `expandWeeklyRules` with the fast version, so that function is also checked against `Intl` on its own: every interval in 8 zones x 53 weeks of 2026 must read back as its rule's weekday and start time, except next to a DST change (which must be rare).
- **Mutation checks** (done by hand, as in the Study Scheduler): 14 deliberate bugs, one at a time (touching intervals not merged, buffers swapped or ignored, notice ignored, horizon off by a millisecond, `>` for `>=` in the daily limit, counting by UTC day, grid rounding down, DST-blind rule ends, a slot not allowed to end exactly at free time, duplicates kept, gap-emptied intervals kept, empty intervals merged, ...). 13 made tests fail. The 14th (`cursor = c.end` instead of `Math.max(cursor, c.end)` in `subtractIntervals`) was an equivalent mutant, since cuts are merged, so the code was simplified to match.
- **Lint now fails on warnings** (`oxlint --deny-warnings`), so warnings can't pile up unread.

### Rule validation (added after the phase 2 review, because of the per-rule anchor)

- **Shared schema:** `weeklyRuleSchema` / `weeklyRulesSchema` in `shared/src/api/availability.ts` (main entry, Zod only). Phase 6's `PUT /api/availability` parses with it, so violations become a 400 through the central error handler. `WeeklyRule` is now inferred from this schema and reused by the slot code.
- **Overlapping rules on the same weekday are rejected** ("Monday 09:00-12:00 overlaps 11:00-14:00"); touching rules (09:00-12:00 + 12:00-17:00) are fine. Sort by weekday then start and compare neighbours: O(n log n). The algorithm itself still tolerates overlaps (de-duplicated starts), so it stays safe if called directly.
- **Rules crossing midnight are rejected, not split.** 22:00-02:00 gets "A rule can't cross midnight: add one ending at 24:00 and another starting at 00:00 the next day". Why reject: with per-rule grids, an automatic split would silently restart the grid at 00:00 and store something other than what the host entered; rejecting keeps stored = applied, keeps each rule a single weekday with start < end (simple CHECK constraint in phase 3), and loses nothing, since a slot still runs across midnight between two touching rules (tested). The phase 8 editor can offer an overnight shortcut that creates the two rules visibly.
- **DST gap and repeat: `RULE_TIME_DISAMBIGUATION = 'compatible'`, passed explicitly.** It's RFC 5545's rule (the iCalendar standard calendar apps follow): a skipped time uses the offset from before the gap (02:30 on 8 Mar 2026 in New York is 03:30 EDT, 07:30Z), a repeated time is its first occurrence (01:30 on 1 Nov 2026 is 01:30 EDT, 05:30Z). Using the same rule as the host's calendar keeps a working-hours boundary and an event at the same wall time on the same instant. `PlainDate.toZonedDateTime` takes no disambiguation option, so conversion goes through `PlainDateTime`. Tests pin each case; mutation checks with `'earlier'`, `'later'` and `'reject'` all fail them.

## Phase 3 decisions (data layer, provider interface, demo login, sessions)

### Prisma version: 6.19.3 (tested, not assumed)

The rule: the newest version whose client runs cleanly under Node type stripping with no build step, locally and on a Vercel function; if 7 needs a build step or workarounds, stay on 6.

- **Prisma 8** is only a release candidate (`8.0.0-rc.20`, although npm's `latest` tag points at it), so not considered.
- **Prisma 7.10** (newest stable) passed the runtime test. Its TypeScript generator reads `tsconfig.json` and, because `allowImportingTsExtensions` is on, writes `.ts` import paths; the generated code has no enums, namespaces or parameter properties. `node src/main.ts` worked locally with no build step, `tsc` passed with this repo's strict settings, and a throwaway Vercel deployment (Node 24.21, `process.features.typescript = "strip"`) loaded the client, the pg driver adapter and the query compiler, failing only at the deliberately unreachable database (P1001).
- **But Prisma 7 needs a workaround to store times correctly.** Its pg adapter writes a `DateTime` as the UTC clock reading *without an offset* (`formatDateTime` in `@prisma/adapter-pg`), so Postgres reads it in the session's time zone, and on reading it relabels whatever comes back as `+00:00`. With a non-UTC session (the author's local Postgres runs in Asia/Kolkata), `09:00Z` was stored as `03:30Z`, while Prisma's own round trip still showed `09:00Z`, so the bug hides itself. Raw SQL, `now()` comparisons and the exclusion constraint across a DST change would all be affected, and local behaviour would differ from Neon (UTC). The fix would be forcing every session to UTC (a database setting plus a startup check): a workaround, so by the rule we stay on 6.
- **Prisma 6.19.3** passed everything with no workaround: it stored `09:00Z` as `09:00Z` in an Asia/Kolkata session, `import { PrismaClient } from '@prisma/client'` works from ESM under type stripping (the client is generated JavaScript), and a throwaway Vercel deployment loaded the query engine and failed only at the unreachable database, without the `includeFiles` setting the Study Scheduler needed. Both versions generated byte-identical SQL for this schema.
- **Throwaway Vercel projects** `prisma7` and `prisma6` (preview deployments, unreachable database, deployment protection on) were left in the author's Vercel account for review; they can be deleted from the dashboard.
- **`npm audit`** reports `deepmerge-ts` (high: stack exhaustion merging recursive objects) inside the Prisma CLI's config loader. It only ever merges our own config at build time and is never bundled into the function, so it's not reachable by a visitor. npm's suggested fix (downgrade to 6.19.3) was checked and doesn't help: 6.19.3 ships the same version. `prisma` is a devDependency (build-time tooling); Prisma 7 additionally pulled in `mysql2` (two high advisories), which 6 doesn't.
- **Seen on the way, for phase 7:** with Prisma 6, the exclusion violation arrives as `PrismaClientUnknownRequestError` whose message contains `23P01` and the constraint name (Prisma 7 had a structured `P2039`). Phase 7 will either recognise it with a small tested helper or insert with `ON CONFLICT DO NOTHING`, which works with exclusion constraints and avoids parsing errors.

### Data model (refinements to the draft)

- **UUIDv7 ids** (`@default(uuid(7)) @db.Uuid`): not guessable or countable like autoincrement ids, and time-ordered so indexes stay compact. The demo uses fixed UUIDs so its links never change.
- **Every timestamp is `timestamptz`.** Prisma's default `timestamp` has no zone, and the exclusion constraint builds `tstzrange` values, which would then depend on the session's zone setting. A test inserts in an Asia/Kolkata session inside one transaction and checks the overlap is still caught.
- **Scheduling settings live on User** (buffers, notice, horizon, max per day): one set per host, always present, with database defaults. A separate table would add a join and a "missing row" case for no benefit.
- **`Booking.hostId` is stored even though the event type knows its owner**, because an exclusion constraint can only compare columns of its own table. A composite foreign key `(eventTypeId, hostId) -> EventType(id, userId)` guarantees the copy is always right.
- **Bookings restrict event type deletion** (`ON DELETE RESTRICT`): an event type with bookings is deactivated, never deleted, so bookings can't vanish by accident.
- **Sign-in identity comes from connections**, not a column on User: `CalendarConnection(provider, externalAccountId)` is unique, where `externalAccountId` is Google's stable `sub` (emails can change). Signing in with any of a user's connected Google accounts finds the same user, and one Google account can't belong to two users. `grantedScopes` records what the user actually ticked on Google's consent screen.
- **`SelectedCalendar` became `Calendar`** (it lists every calendar of a connection, with `countsAsBusy`), and **`DemoBusyEvent` belongs to a calendar**, not a user, so "which calendars count as busy" works in the demo too.
- **`Session` table** (new): see Sessions below.
- **Deferred:** which calendar new bookings go into arrives with phase 7. Phase 6 added `Booking.calendarId` (the calendar holding the booking's event), which account deletion needs.

### Hand-written constraints, and the check that keeps them

Added by hand at the end of the init migration: the bookings' exclusion constraint (`btree_gist`, `tstzrange(..., '[)')`, only `CONFIRMED`), an exclusion constraint so a host's rules on one weekday can't overlap (`int4range`, the database twin of the phase 2 Zod rule), and CHECKs for rule minutes and weekday, settings ranges, booking times, `cancelledAt` matching the status, handle and slug format, and lowercase emails.

- **Prisma ignores them when diffing:** a probe `migrate dev --create-only` right after produced an empty migration. That's today; a future schema change or hand edit could still drop or weaken one.
- **`tests/db/constraints.test.ts`** runs after every migration and compares the full list of CHECK and EXCLUDE constraints with their exact `pg_get_constraintdef` text, so dropping, renaming or weakening any of them fails. Behaviour tests back it up (overlap rejected, touching allowed, cancelled ignored, other hosts independent, wrong host rejected by the composite key).
- **Proven:** a fake later migration that recreated the booking constraint without its `WHERE` failed 3 tests; one that dropped it failed 4.
- **`tests/db/migrations.test.ts`** runs `prisma migrate diff` from the migrated test database to `schema.prisma` and expects an empty diff, so a model change without a migration fails CI.

### CalendarProvider interface

`server/src/calendar/provider.ts`: `listCalendars`, `getBusyIntervals`, `createEvent`, `deleteEvent`. Refinements: `deleteEvent` also takes the calendar id (Google's API needs it), busy time is returned as UTC epoch-ms intervals so it goes straight into `computeSlots`, `deleteEvent` is idempotent (Google answers 410 for an already deleted event), and failures are a `CalendarProviderError` with a `kind` the app can act on (`auth` -> needs reconnect, `rate_limited`, `not_found`, `unavailable`). **DemoCalendarProvider** reads and writes `DemoBusyEvent` rows, keeping only start and end (like what we read from Google); creating an event makes that time busy, as Google would.

### Sessions and CSRF

- **Server-side sessions:** the cookie holds 32 random bytes; the `Session` table stores only their SHA-256, so a database leak contains no working sessions (a plain hash suffices because the token is random, not a password). Logout deletes the row, so a copied cookie stops working at once, which a signed JWT can't do.
- **Lifetime and cleanup:** 14 days, fixed from sign-in (not extended by use). An expired session is refused and deleted when its cookie comes back, and every sign-in also deletes all expired sessions (indexed on `expiresAt`), because serverless instances have no reliable background timer.
- **Session fixation:** every sign-in goes through one function, `startSession` (the Google callback in phase 4 uses it too). It always issues a brand-new random token, never the one the browser sent, and deletes the browser's previous session. Tests plant both an unknown token and the attacker's own valid session in the browser before sign-in: neither comes back as the session, and the attacker's copy stops working.
- **Cookie:** `httpOnly` (scripts can't read it, so an XSS bug can't send it away), `SameSite=Lax`, `Path=/`, and in production `Secure` with the `__Host-` prefix (the browser then refuses the cookie unless it's HTTPS-only with no `Domain`, so no subdomain can set or overwrite it). Local http://localhost can do neither, so they're production-only.
- **CSRF, what changes with a cookie:** a token in localStorage is only sent by our own JavaScript, so other sites can't use it; a cookie is sent by the browser automatically, so a page on another site could try to submit a request that rides on it (cross-site request forgery). How it's handled:
  1. `SameSite=Lax` stops the browser attaching the cookie to cross-site POST/PUT/PATCH/DELETE requests. Lax rather than Strict because Strict would also drop it on the top-level redirect back from Google's sign-in page.
  2. Lax still sends the cookie on top-level cross-site GET navigations, so **GET requests never change anything** (logout is a POST).
  3. **Origin check** (`requireSameOrigin`), defence in depth: a state-changing request must carry an `Origin` header whose host equals the request's `Host`, or it gets 403. Browsers always send `Origin` on POST/PUT/PATCH/DELETE (the Fetch standard requires it, same-origin too) and page scripts can't change it, so another site can't fake it, and a request without one isn't from our pages; it's rejected too (tested, including `Sec-Fetch-Site: same-origin` alone, `Origin: null`, a malformed Origin and the same host on another port). curl and other scripts must send `Origin`. This works on every Vercel URL and behind the Vite proxy with no allow-list.
  4. **JSON-only bodies:** the API only parses `application/json`, which a plain HTML form can't send cross-site without a CORS preflight, and there's no CORS.
  5. Other `*.vercel.app` projects are cross-site to us, because `vercel.app` is on the Public Suffix List, so SameSite treats them as separate sites.
- **`Cache-Control: no-store`** on every API response, so private data never sits in a shared cache.
- **Caught by running it for real:** a manual end-to-end check through the Vite proxy found every same-origin POST blocked. Vite's string shorthand for a proxy turns on `changeOrigin`, which rewrote `Host` to `localhost:4200` while the browser's `Origin` stayed `localhost:5190`. Fixed with `changeOrigin: false` (which also matches production, where browser and API share one origin), and a client test pins the setting.

### Demo host login, rate limits, app wiring

- `POST /api/auth/demo` creates the demo host "Priya" (Asia/Kolkata) on first use: three calendars (Work and Personal count as busy, "Holidays in India" doesn't), weekday hours 10:00-13:00 and 14:00-18:00 plus Saturday mornings, the three event types, buffers 5/10 minutes, 4-hour notice, 30-day horizon, max 6 per day. Busy events cover the day before today through three weeks ahead, deterministic per date (seeded from the date), so a reset never reshuffles a day someone is looking at. Two simultaneous first logins are handled (the loser's unique violation is ignored). Phase 10 adds the periodic, locked reset.
- **Rate limiting:** the Study Scheduler's Postgres-backed store, ported to TypeScript, so every serverless instance shares counts. Demo login: 30 per client per 15 minutes. Clients are keyed by the address Vercel's edge adds (trust proxy = 1 hop), so faking earlier `X-Forwarded-For` entries doesn't help (tested).
- **`createApp({ db, production, now, rateLimits })`:** dependencies are passed in rather than read from module globals, so tests use the test database, move the clock (session expiry) and switch rate limits off without environment tricks.
- **Tests:** a `*_test`-only guard before migrating or truncating, `prisma migrate deploy` once per run, files run one at a time against the shared test database. CI gets a Postgres 17 service (Neon's major version). Lint config: oxlint's `no-async-endpoint-handlers` is off for server code (an Express 4 concern; Express 5 forwards rejections, which a test proves), and Vitest's two-argument `expect(value, message)` is allowed.
- **Mutation checks:** 10 deliberate breaks of the session, cookie and origin code (any Origin accepted, Sec-Fetch-Site ignored, SameSite=None, not httpOnly, token stored in plain text, expiry ignored or off by a millisecond, logout keeping the row, demo login leaving the old session valid, the demo race not tolerated): every one failed at least one test.

## Phase 4 decisions (Google OAuth)

Setup steps for the Google Cloud project are in **docs/google-setup.md** (checked against Google's docs in October 2026, sources listed there).

### Scopes (the narrowest that work)

`openid email profile` for identity, plus three Calendar scopes picked from the per-method scope lists in Google's API reference:

| Scope | Class | Needed for |
|---|---|---|
| `calendar.calendarlist.readonly` | non-sensitive | `calendarList.list`: choosing which calendars count as busy |
| `calendar.events.freebusy` | non-sensitive | `freebusy.query`: busy intervals only, never event details, on every calendar the user can see (phase 5 found the narrower `calendar.freebusy` returns `notFound` for subscribed and shared calendars) |
| `calendar.events.owned` | sensitive | `events.insert`/`events.delete` on calendars the user owns: the booking's event and its invitation |

Not `calendar.readonly` (would expose every event's details) or `calendar.events` (edit rights on every calendar the user can access). `calendar.app.created` is narrower still but only covers calendars the app itself creates, so bookings wouldn't land on the host's own calendar. If a user unticks a Calendar scope on Google's consent screen (granular consent), the partial grant is revoked and they're told calendar access is needed.

### The flow, step by step (`server/src/routes/googleAuth.ts`)

1. **`GET /api/auth/google/start`** creates three random 32-byte values: `state` (CSRF on the callback), a PKCE `code_verifier` (its SHA-256 `code_challenge` goes to Google; the verifier never leaves the server until the code exchange) and an OIDC `nonce` (stops ID-token replay). They travel to the callback in **one signed cookie**: HMAC-SHA256 with `COOKIE_SIGNING_SECRET`, 10-minute expiry inside the signed payload, httpOnly, `SameSite=Lax` (Strict wouldn't be sent on the redirect back from accounts.google.com), Secure and `__Host-` in production. Signed, not stored server-side: nothing to clean up, and every value is single-use. Then a 302 to Google with `access_type=offline`, `include_granted_scopes=true`, `code_challenge_method=S256` and `prompt=select_account` (or `consent`, see 6).
2. **Callback: the cookie** must be present, correctly signed and unexpired; it's cleared at once. A tampered, expired or missing cookie (including an attacker's callback link opened in a victim's browser) ends with `?error=expired`.
3. **`state`** from Google must equal the cookie's (constant-time comparison), before the code is even exchanged. This stops login CSRF: an attacker sending someone a callback with the attacker's own code.
4. **Code exchange** from the server with the client secret and the PKCE verifier. Errors carry only Google's error code and status, never the request body (tested: logs never contain the client secret, the code or the verifier).
5. **ID token verification** with `jose`: RS256 signature against Google's published keys (JWKS, cached), issuer (`https://accounts.google.com` or `accounts.google.com`), audience (our client id), expiry (30 s clock tolerance), then our nonce, and `email_verified`. Only then is the identity trusted.
6. **Refresh token:** Google returns one only on first consent. If none arrives, a stored one that still works is kept (re-encrypted under the current key). If there's no usable one (first time, or after "needs reconnect"), the callback restarts the flow once with `prompt=consent` and a `login_hint`, which makes Google issue a new one; if even that returns none, it stops with `?error=no_refresh_token` instead of looping.
7. **Save and sign in.** Sign-in finds the user by the connection's Google `sub`, never by email: emails change and can be recycled, so a different Google account with the same address as a connected one must not reach that user's calendars (tested). A new user gets a handle from their name (`sesha-sai-tunuguntla`, a random suffix if taken) and the browser's time zone (validated; offsets like `+05:30` fall back to UTC). Then `startSession` issues a fresh session token (phase 3's fixation protection) and redirects to `/dashboard`. Errors redirect to `/login?error=<code>` (or `/calendars` when connecting) with a fixed code, never text from Google.

**Connecting a second account** (`?intent=connect`) needs a signed-in, non-demo user; the user id goes into the signed cookie, and at the callback the browser must still be signed in as that same user (tested: signing out, or in as someone else, in between fails). An account already connected to another user is refused.

### Tokens at rest (`server/src/auth/tokenCrypto.ts`)

- **AES-256-GCM** (authenticated: tampering or a wrong key fails instead of producing garbage), a fresh random 12-byte IV per encryption, and **additional authenticated data `google:<sub>:<refresh|access>`**, so an encrypted token copied into another row or field won't decrypt. Format `iv.ciphertext.tag` (base64url).
- **Versioned keys:** `TOKEN_ENCRYPTION_KEYS="2:<new>,1:<old>"`; the first encrypts, all decrypt, each row stores `tokenKeyVersion`. Rotation: put the new key first and deploy, run `npm run tokens:reencrypt --workspace server` (moves every row to the new key; a row refreshed at the same moment isn't overwritten), then remove the old key. Tested end to end, including decrypting with only the new key afterwards.
- Access tokens are stored encrypted too, so serverless instances share them instead of refreshing on every request.
- **Never logged:** tokens and secrets never appear in error messages; errors from Google carry its error code only.

### Refresh and "needs reconnect" (`server/src/google/tokens.ts`)

`GoogleTokens.accessToken(connectionId)` returns the stored access token while more than 5 minutes are left, otherwise refreshes it first (storing a rotated refresh token if Google sends one). On `invalid_grant` (revoked by the user, password change, or Testing mode's 7-day expiry) it marks the connection `NEEDS_RECONNECT`, deletes the dead tokens and throws a `CalendarProviderError('auth')`; later calls fail fast without calling Google. Network or other errors are `unavailable` and leave the connection `ACTIVE`. Signing in again (with the forced-consent retry from step 6) makes it `ACTIVE` again. Phase 5's Google provider uses this service.

### Connections and disconnect

- `GET /api/connections`: provider, account email, status (`ACTIVE` / `NEEDS_RECONNECT`, for the "Reconnect Google" state) and `canDisconnect`; never tokens.
- `DELETE /api/connections/:id`: revokes the refresh token at Google (which also revokes its access tokens; Google's `invalid_token` for an already-revoked token counts as revoked), then deletes the connection and its calendars. If Google can't be reached, our copy is deleted anyway and the response says `revokedAtGoogle: false`. The last Google account can't be disconnected (409): it's how the user signs in, and signing in again would create a new, empty account. The demo calendar can't be disconnected; another user's connection is a 404.

### Configuration

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_ORIGIN` (the redirect URI is derived: `<APP_ORIGIN>/api/auth/google/callback`), `COOKIE_SIGNING_SECRET`, `TOKEN_ENCRYPTION_KEYS`. All optional in development (Google routes answer 503, the demo works), all required in production, and a partial set fails at startup naming what's missing (never a value). The redirect URI uses the client's port (5190) so the flow cookie and the session cookie live on the app's own origin.

### Testing without Google

A fake Google (`tests/helpers/fakeGoogle.ts`) behind the app's injected `fetch`: single-use codes bound to the PKCE challenge (the verifier is checked like Google does), real RS256 ID tokens signed with a key in a local JWKS (plus a second, unpublished key for forgery tests), revocable and optionally rotating refresh tokens, `invalid_grant` for revoked ones, refresh tokens only on first consent or `prompt=consent`, and switchable failures. A small cookie-keeping test browser drives start -> Google -> callback. Unit tests use the RFC 7636 PKCE example.

**Mutation checks:** 22 deliberate weakenings (state not compared, nonce/audience/issuer/email_verified not checked, PKCE `plain`, cookie signature or expiry ignored, missing scopes accepted, no consent-loop guard, connect not checking which user is signed in, demo allowed to connect, no AAD, fixed IV, no refresh margin, `invalid_grant` not marking reconnect, network errors treated as `invalid_grant`, rotated refresh token dropped, disconnect not revoking, last account disconnectable, account looked up by email). Three survived the first run and each exposed a missing test (signed in as a different user during connect, refresh-token rotation, and the email-reuse takeover); after adding those, all 22 fail at least one test.

## Phase 5 decisions (Google Calendar provider)

`server/src/calendar/googleProvider.ts` implements the phase 3 interface against the Calendar API with plain `fetch` (injected, so tests use the fake Google). Only three read endpoints exist in the code: `calendarList` (names and access roles, shown to the host only) and `freeBusy` (busy intervals only); event details are never requested, so they can't leak or be stored. Plus `events.insert` and `events.delete` for bookings.

- **Fail closed on unreadable calendars.** `freeBusy` reports errors per calendar (`notFound` when it can't be read). If any requested calendar fails, `getBusyIntervals` throws (`not_found` or `unavailable`, naming the calendar) instead of returning the others' busy time: showing slots without knowing a calendar's busy time could double-book the host. Phase 6 turns this into a clear message for the host and no slots for guests.
- **Limits:** at most 50 calendars per `freeBusy` request (documented) and ranges split into 60-day windows. Google doesn't document a maximum range; measured on a real account (6 Oct 2026), 92 days was accepted and 100 days rejected with `400 timeRangeTooLong`, so 60 leaves a wide margin.
- **Errors, following [Google's guide](https://developers.google.com/workspace/calendar/api/guides/errors):** 401 -> refresh the access token once (`forceRefresh`) and retry, then `auth`; 403 `insufficientPermissions` -> mark the connection `NEEDS_RECONNECT` (`auth`); 429 and 403 `rateLimitExceeded`/`userRateLimitExceeded`, 5xx and network errors -> retried twice with exponential backoff and jitter (250 ms, 500 ms) or `Retry-After` (capped at 5 s, so a booking never hangs), then `rate_limited` / `unavailable`; 404 and other 403s -> `not_found`. Error messages never contain tokens (tested).
- **Idempotent event creation:** `NewCalendarEvent.idempotencyKey` (the booking's UUID) becomes the Google event id (a UUID's hex digits are valid base32hex). If a create is retried after a timeout, Google answers 409 `duplicate` and the same id is returned, so a guest can never get two invitations. The demo provider does the same with an upsert. Phase 7 relies on this.
- **Invitations:** `events.insert` and `events.delete` use `sendUpdates=all`, so Google emails the guest the invitation and the cancellation (no email sending of our own, as planned). Deleting is idempotent: 404 and 410 `deleted` count as success.
- **Owned calendars only:** `calendar.events.owned` covers calendars the user owns, so a new `Calendar.canCreateEvents` column (migration `add_calendar_can_create_events`) records `accessRole === 'owner'`; creating an event elsewhere fails `not_found`. Phase 6/7 offer only these as the booking calendar.
- **Calendar sync** (`syncCalendars`): after Google sign-in or connect, the calendar list is copied into `Calendar` rows. New calendars count as busy only if the user owns them (subscribed holidays, birthdays or a colleague's shared calendar usually shouldn't block bookings; the host can tick them). Later syncs keep the host's choices, update names and access, and remove calendars that are gone. Best effort during sign-in: if it fails, signing in still works and phase 6's calendars page syncs again.
- **Tests:** the fake Google now serves the Calendar API (bearer-token checks, pagination, per-calendar `notFound`, created events becoming busy, 403 for non-owned calendars, 409 duplicates, 410 for deleted events, scripted failures with `Retry-After`). 22 provider tests; 16 mutation checks all failed at least one test.

### Free/busy scope: `calendar.events.freebusy`

Google describes `calendar.freebusy` as "View your availability in **your** calendars" and `calendar.events.freebusy` as "See the availability on Google calendars **you have access to**" ([scopes](https://developers.google.com/workspace/calendar/api/auth)); both are non-sensitive. Checked on a real Gmail account on 6 Oct 2026 with `npm run google:check --workspace server` (prints owned / not owned and whether `freeBusy` can read each calendar; counts only, no tokens or event details):

| | `calendar.freebusy` only | with `calendar.events.freebusy` (token checked via tokeninfo) |
|---|---|---|
| own primary calendar | readable | readable |
| subscribed "Holidays in India" (two variants) | `notFound` | `notFound` |
| other public holiday calendars (US, UK), not subscribed | | `notFound` |
| one 120-day request | `400 timeRangeTooLong` | `400 timeRangeTooLong` |

So `freeBusy` doesn't serve Google's holiday calendars under either scope, and the holiday test can't tell the two scopes apart.

**Untested:** a calendar shared by another person, the case `calendar.events.freebusy` is for. It stays untested until a calendar is shared from a second account with the test account; then rerun the check and record the result here.

Decision: request `calendar.events.freebusy`, the scope Google documents for calendars the user has access to; it's equally non-sensitive and still returns busy times only. Connections made before the switch keep the old grant until the user signs in again.

**For phase 6:** some calendars in the list can't be read by `freeBusy` at all (holiday calendars; probably birthdays/contacts too). Because busy lookups fail closed, ticking one would hide every slot. The calendars API must refuse to count such a calendar as busy, and the UI should explain why. Approved: during `syncCalendars`, one short `freeBusy` probe over all listed calendars records whether each can be read, rather than guessing from calendar id patterns. Refinement (approved): only a permanent answer (`notFound` for that calendar) marks it unreadable; a temporary failure (5xx, rate limits, network) must not, and instead shows a clear "can't check your calendar right now" state. Both cases tested.

## Phase 6 decisions (host settings, event types, slots, account deletion)

All backend; the pages come in phases 8-9. Every request and response has a shared Zod schema (`shared/src/api/`), which the server parses with and the tests check responses against.

### Which calendars can count as busy (the approved holiday-calendar refinement)

- **`Calendar.busyAccess`**: `READABLE`, `UNREADABLE` or `UNKNOWN`, from a new provider method, `checkBusyAccess`: one `freeBusy` request per 50 calendars, read per calendar. Only Google's `notFound` for a calendar is permanent (`UNREADABLE`). Any other per-calendar error (`backendError`, `internalError`), or the whole request failing (5xx, rate limits, network, after the provider's retries), is temporary: `UNKNOWN`, which the UI shows as "can't check your calendar right now". A temporary failure never marks a calendar unreadable (tested both ways, at sync and when ticking).
- **Sync** (after sign-in, and `POST /api/calendars/sync`) records access for every calendar. If only the check fails, the list is still saved with `UNKNOWN`. If listing fails temporarily, the account's calendars are kept and marked `UNKNOWN`; if access was revoked, the connection becomes `NEEDS_RECONNECT` (as in phase 4) and its calendars are left as they were. New calendars count as busy only if owned and not unreadable.
- **Ticking re-checks live, every time** (`PATCH /api/calendars/:id {countsAsBusy: true}`), so a stored answer never goes stale: unreadable -> 409 with an explanation (holiday calendars as the example); temporary -> 503 "Can't check your calendar right now. Try again in a minute." and `UNKNOWN`; revoked -> 409 "Reconnect <account>". **Unticking always works**, even with Google down.
- No CHECK constraint forbids "unreadable and ticked": a calendar that later becomes unreadable (sharing withdrawn) must keep failing closed until the host unticks it, rather than be unticked silently and allow double-booking.
- **The demo mirrors Google:** its "Holidays in India" calendar now has Google's real holiday-calendar id, and the demo provider treats that id pattern exactly as Google does (unreadable; busy lookups fail `not_found`). It no longer generates holiday events nobody could read. The README's known trade-offs explain why holidays don't block bookings.
- **`HttpError` may be 5xx now.** The central error handler passed only 4xx messages through, so a 503 "try again later" arrived as a generic 500. `HttpError` is always written to be client-safe, so its status and message now pass through whatever the status; a 5xx from anywhere else is still hidden (both tested).

### Availability and event types

- **`GET/PUT /api/availability`**: time zone, weekly rules and settings together; PUT replaces all of it in one transaction, so slots never see half an update. Validation is the shared schema (phase 2's overlap and midnight rules, settings ranges equal to the database CHECKs, IANA zones only), so messages match the client's.
- **`/api/event-types`** (GET, POST, PATCH, DELETE): responses include `bookingPath` (`/book/<handle>/<slug>`). A slug the host already uses -> 409 naming it; another host's id -> 404 like a missing one; at most 50 per host (the demo host is shared, so a script can't fill the table). **An event type with bookings can't be deleted** (409, "turn it off instead"): checked before deleting, because Prisma 6 reports the database's RESTRICT violation (Postgres `23001`) only as an unparsed error, the same problem as `23P01` in phase 3. The foreign key still guards the race with a new booking (the delete fails; nothing is lost).

### Slots

- **Routes moved under `/api/public/book/`** (like the page, `/book/:handle/:slug`). With the draft's `/api/public/:handle/:slug`, a host whose handle is `bookings` would collide with phase 7's `/api/public/bookings/:token`.
- **`?from=&to=&tz=` are dates in the guest's zone** (to exclusive, at most 42 days). The server turns them into instants with Temporal (`localDayInterval`), so the client needs no time-zone library; it groups the returned UTC slots by the guest's date with `localParts`. Tested: 09:00 IST on Monday is Sunday evening for a New York guest.
- **`availableSlots`** gathers the inputs and calls phase 2's pure `computeSlots`: the host's rules, busy times from every calendar that counts as busy (each connection's provider in parallel), and confirmed bookings (busy, and counted for the daily limit). Busy times are fetched only for the part of the request that minimum notice and the horizon leave open, widened by the buffers and the event's length, so a past or far-future week costs no Google request (tested); bookings get two extra days either side so whole local days are counted.
- **Fails closed** (phase 5's rule): if any calendar that counts as busy can't be read (unreadable, Google down or rate limiting, access revoked), the guest gets 503 "This booking page can't show times right now" and no slots. The message never names a calendar or account; the log gets the error kind, never tokens. The worked example from this plan runs end to end through the API (Google host, fake Google busy times) and offers only 12:30-13:00 IST.

### Protecting Google from the public slots endpoint (checked before the phase 6 commit)

The slots endpoint needs no sign-in and reads the host's calendars, so three limits sit in front of Google:

1. **Rate limit on every public endpoint**, with the Postgres limiter: one limiter on the whole `/api/public` router (so phase 7's public routes get it too), 300 requests per client per 15 minutes, counted together across endpoints and server instances. Requests for pages that don't exist count too, so probing for handles is limited. Tested: 300 mixed requests, then 429 on both endpoints, counted in one `RateLimit` row, another client unaffected.
2. **A 60-second busy-time cache per host** (`BusyCache` table, `src/calendar/busyCache.ts`), so many guests on the same page cause one read of the calendars. In Postgres rather than memory: on Vercel each instance has its own memory, so an in-memory cache would mean one read per instance, and clearing it on one instance (a booking) wouldn't clear the others. Each read covers the requested span plus an hour of slack, so later requests (whose span shifts as the notice edge moves with "now", or which are for a longer event type) reuse it. On one instance, the per-host decision "join a read in progress, use the table, or start a read" is taken one request at a time, so guests arriving together share one read (tested; without it, 5 simultaneous guests caused 3 reads). Failures aren't cached. Cleared when a host ticks or unticks a calendar, refreshes calendars, signs in or connects (sync), or disconnects an account; phase 7 clears it on every booking and cancellation. A read that was running when the cache was cleared isn't stored. Expired rows of every host are deleted as new ones are stored; rows go with the host on account deletion. **Bookings are never cached:** slots always read our own bookings fresh, so a booking made a second ago blocks its time whatever the cache holds.
3. **Ranges capped at the booking horizon:** at most 42 days per request, and Google is only asked about the part that minimum notice and the horizon leave open (plus the event's length, buffers and the hour of slack). Tested: a 42-day request with a 30-day horizon asks Google for exactly now to 30 days + 90 minutes, and a range entirely past the horizon or in the past asks nothing.

Mutation checks on these: 14 breaks (no freshness check, TTL boundary off by one, rows used without covering the range, no slack, decisions not one at a time, reads in progress not joined, invalidation not stopping a read in progress, a pre-clear read stored, expired rows kept, the horizon not capping the read, ticking / syncing / disconnecting not clearing the cache, the limiter removed): all 14 failed at least one test.

### Delete my account (`DELETE /api/account`)

As planned, with two details settled: bookings now record **`calendarId`** (the calendar holding their event; set null if that calendar disappears), which is what lets step 1 find and delete each upcoming booking's event; phase 7 fills it in. And the response is **200 with `{ revokedAtGoogle, eventsNotDeleted }`** rather than 204, because the plan also wants it to say when Google couldn't be reached. Tests: every table holds only the other user's rows afterwards; both of the user's Google accounts are revoked (the other host's isn't); upcoming events are deleted with `sendUpdates=all` and the past one is left; every session of the user ends; a wrong or differently-cased handle changes nothing; the demo host gets 403; with Google unreachable everything is still deleted and the response says so; `Origin` is required; and the same Google account can sign up again afterwards as a fresh, empty user.

### Mutation checks

35 deliberate breaks, one at a time: ticking without the live check; a temporary failure (while ticking, during sync, or per calendar) recorded as unreadable; `UNKNOWN` accepted as readable; unticking blocked by the check; revoked access answered as "try again"; sync marking calendars `UNKNOWN` after revoked access, or not after a listing failure; Google's `notFound` treated as temporary, or every error as permanent; slots ignoring calendar busy times, bookings, or which calendars count; cancelled bookings blocking; the busy lookup not widened by the buffer; guest dates read as UTC days; turned-off event types public; the provider's error text shown to guests; account deletion allowed for the demo, without the handle, without deleting events, deleting past events too, without revoking, without deleting bookings first, or leaving the cookie; slug clashes unexplained; event types with bookings deletable; the 50 limit off by one; another host's event type reachable; old rules kept or settings not saved; `HttpError` 503 hidden as 500; the demo reading holiday calendars. 34 failed at least one test on the first run. The survivor (reporting `revokedAtGoogle: true` when only one of two accounts was revoked) exposed a missing test, which now exists.

## Phase 7 decisions (booking, cancel, reschedule)

`server/src/bookings/bookings.ts`; routes in `routes/publicBooking.ts` (guests) and `routes/bookings.ts` (the host).

### Never double-booking the host

1. **Check against fresh data.** A booking reads the host's calendars directly, not through the 60-second cache (a guest's page can be a minute old), plus the bookings in our database. Outside any lock, because it's the slow part.
2. **Then take the host's lock and check again.** A Postgres advisory lock (`pg_advisory_xact_lock` on the host id, held until the transaction ends), so it works across serverless instances and only ever blocks that one host. Inside it, the same slot check runs with the bookings as they are now. Two guests who both passed step 1 for the same slot are now in line: the second sees the first's booking and gets **409 "That time was just taken"**. The same goes for two different slots competing for the last booking of a day with a daily limit, which the exclusion constraint alone couldn't catch (the slots don't overlap).
3. **The calendar event is created inside the same transaction.** If Google fails, the transaction rolls back: there is no booking, the guest is told "nothing was booked, please try again", and the slot stays free. **We choose the event's id before the call:** it's the booking's UUID (generated by the database when the row is inserted, inside the transaction) with the hyphens removed, sent to Google as the event's `id`. So if Google created the event but the answer was lost (an error after it acted, or our timeout), the app still knows the id and withdraws it (with `sendUpdates=all`, which also withdraws the invitation). Tested both ways: Google answering 500 after creating it, and Google answering after our deadline; in both, the deleted event's id is the one sent in the insert. Holding a transaction during a Google call is normally avoided; here it is one host's lock for at most a few seconds (see time limits below), and it keeps our records and the host's calendar from ever disagreeing.
4. **The exclusion constraint stays the last line of defence.** Prisma 6 reports its violation (23P01) only as text, so `isOverlappingBooking` recognises it (tested against a real violation) and it becomes the same 409. With every booking change taking the lock it shouldn't be reachable, so no API test can reach it; only the recogniser is tested.

**Concurrency tests:** both races (same slot; last slot of a day) run two real requests at once. To keep them from depending on timing, the app accepts a test-only hook that runs between the first check and the lock (`beforeBookingLock`, like the injectable clock); the tests use it to hold both requests there until both have passed the first check. Without the lock, the daily-limit race books both.

Messages: a start that wasn't free at the first check gets "That time isn't available" (an off-grid time, outside working hours, past, beyond the horizon, or already booked); losing the race inside the lock gets "That time was just taken".

### The guest's manage link

- **32 random bytes** (base64url), returned once, in the booking's response; only the SHA-256 is stored (like sessions), and lookups are by hash. The link is `/booking/<token>`. A wrong or malformed token gets the same 404. The token is never put in the calendar event (the host's calendar may be shared with others, who could then cancel the guest's booking).
- **The guest view** shows the guest's own booking, the host's name and time zone and the event type: never the host's email or anything else private. `canChange` is true until the meeting starts.
- **Cancel** takes the lock, deletes the event (`sendUpdates=all`: Google tells the guest), then marks the booking cancelled. If Google is down or slow, the booking stays on and the guest is asked to try again ("couldn't confirm the cancellation"): Google may or may not have deleted the event before our deadline, and deleting again is harmless (404/410 count as deleted), so the retry finishes it (tested). Cancelling twice is fine.
- **Cancel with expired access** (approved after the phase 7 review): if the host's Google access has expired (7 days in Testing mode), the booking is cancelled anyway, because a guest must always be able to cancel, and marked **`stillOnCalendar`** ("cancelled, still on your calendar"; a CHECK allows it only on cancelled bookings). The host's booking list includes such bookings with the flag, for the phase 8 dashboard. Removing the event is retried (`retryEventRemovals`) when the host signs in or connects that account again and when they refresh their calendars; an event that still can't be removed stays marked, one already deleted by hand counts as removed. Tested: the flag and the list, removal on sign-in (Google tells the guest), Google down at sign-in then removed on the next refresh, and an event already deleted.
- **Reschedule** moves the same booking and the same event (`events.patch`, only start and end, `sendUpdates=all`), so the guest gets an "updated" email rather than a cancellation and a new invitation, and the manage link keeps working. The new time goes through the same check, lock and re-check, leaving the booking itself out so it doesn't block or count against itself. Google down or slow -> nothing changes (503), and if the move may have reached Google before our deadline, the event is moved back (the undo is recorded before the call; tested with a move Google applied but answered too late); the event deleted from the host's calendar or access expired -> 409 "can't be moved, cancel and book a new time", because moving only our record would leave the host's calendar showing the old time.
- **Limitation, accepted in the phase 7 review: no rescheduling into an overlapping time.** While a booking is being moved, the host's calendar still shows its event at the old time, and Google's `freeBusy` returns merged busy ranges with no event ids, so the app can't subtract the booking's own event: subtracting its interval could also erase another event that overlaps it (two overlapping events come back as one range). So a new time overlapping the current one (e.g. 15 minutes later for a 30-minute meeting) isn't offered; cancelling and booking works. In the README's known trade-offs.
- A booking keeps its own length when rescheduled, even if the event type's has changed since.

### The host's side

- **`GET /api/bookings`**: upcoming confirmed bookings (including one in progress), soonest first, 20 at a time with keyset paging (`?cursor=<last id>`, ordered by start then id, so a booking made meanwhile can't shift pages). Guest names and emails appear here and nowhere public. **`POST /api/bookings/:id/cancel`**: the same cancel as the guest's.
- **Booking calendar:** `User.bookingCalendarId` (`PUT /api/calendars/booking-calendar`), which must be a calendar the host owns (a shared or subscribed one is refused: `calendar.events.owned` can't write there). Unset, or no longer usable: the primary calendar of the host's first account. `GET /api/calendars` reports the effective one. The foreign key can't check that the calendar is the user's own (a calendar row has no user id), so the app does.
- **Rate limits:** the shared public limiter now sits on all of `/api/public` once (each request counts once whichever router answers it), and making, cancelling or rescheduling a booking also counts against a stricter **10 per client per 15 minutes**, since each one writes to the host's calendar. **Daily limit (added after the phase 7 review):** every booking makes Google email an invitation to any address the guest types, so creating bookings with real hosts is also limited to **10 successful bookings per client per 24 hours** (Postgres limiter; failed attempts give their count back; demo bookings send no email and are exempt). In the README's known trade-offs: people on one office or mobile network share the allowance. Tested with the rate-limit clock moved past the 15-minute window: the 11th successful booking of the day gets 429, a failed attempt didn't count, a demo booking still works, and the next day booking works again.

### Time limits (added after the phase 7 review)

Every limit is in `src/bookings/timeouts.ts`, and a unit test checks they fit together:

| Limit | Value | What it bounds |
|---|---|---|
| `googleCallMs` | 6 s | One Google Calendar call: token refresh (the OAuth request takes the same deadline), every attempt (each at most half the budget, so a hung first try leaves room for a retry) and the waits between them. Past it: `unavailable`, which every caller treats as temporary. |
| `lockWaitMs` | 5 s | Waiting for another booking change of the same host (`SET LOCAL lock_timeout`); past it, "Someone else is booking with <host> right now. Please try again in a moment." (503). |
| `connectionWaitMs` | 3 s | Waiting for a pooled database connection (Prisma `maxWait`). |
| `transactionMs` | 15 s | The booking transaction (Prisma `timeout`): lock wait + one Google call + database time (2 s margin) fit inside it, so it never cuts a Google call off midway. If Prisma's own limits are hit anyway, the same 503. |

Worst case for one booking request: read (6) + connection (3) + lock (5) + create (6) + withdraw (6) + database (2) = **28 s**, under the **60-second** maximum duration the API function gets on Vercel (phase 12; Vercel allows up to 300 s on every plan with Fluid compute, checked October 2026). **Tested with a slow fake Google** (answers delayed past the deadline, honouring the abort signal like a real request), on an app with shortened limits: event creation too slow -> 503 "nothing was booked" within the deadline, no booking, no event; created but answered too late -> the event is withdrawn; free/busy check too slow -> 503, nothing booked; a second guest kept waiting for the lock -> 503 "try again in a moment" while the first is booked; a cancellation that timed out keeps the booking and a retry finishes it; a reschedule that timed out after Google moved the event moves it back.

**Mutation checks on the review additions:** 14 breaks (no overall deadline on a Google call; retrying with no time left; no lock-wait limit; the lock timeout not explained; the reschedule undo recorded only after the move; expired-access cancels not marked; the retry never removing the event, or not running on sign-in or on refresh; still-on-calendar bookings hidden from the host; the daily limit counting failures, not exempting the demo, using a 15-minute window, or removed): all 14 failed at least one test. The token refresh's share of a call's deadline is tested separately (closing a gap from the phase 7 review): a connection is seeded with an already-expired access token, so the call must refresh first; with the OAuth endpoint slow, the call ends at its limit (300 ms in the test) as `unavailable`, the connection stays `ACTIVE`, and letting the refresh ignore the deadline fails the test.
- **Cache:** booking, cancelling and rescheduling clear the host's busy-time cache (tested: each test loads the slots first, so the cached copy would show the wrong time if it weren't cleared).
- **Provider:** Google's 410 Gone (an event deleted on the host's calendar) is now `not_found` instead of a temporary failure; `moveEvent` and `eventIdFor` were added to both providers.

### Mutation checks

25 deliberate breaks: no re-check inside the lock; no lock; the first check skipped, or without calendar busy times; the booking kept when Google fails; an orphaned event not withdrawn; the manage token stored in plain text; the booking calendar choice ignored, or shared calendars allowed as one; booking, cancelling or rescheduling not clearing the cache; started meetings cancellable; cancelling with Google down, not blocking; expired access blocking a cancel; cancelling not idempotent; a reschedule counting against itself, not moving the event, or treating a deleted event as temporary; the guest view always changeable; cancelled bookings in the host's list; another host's booking cancellable; Google's 410 treated as temporary; the booking limiter removed. 24 failed at least one test (one of them only after a first attempt at the mutation turned out not to change behaviour). The survivor is the 23P01 mapping, which no request can reach while every booking change takes the lock; its recogniser is tested on its own. Also untested for the same reason: moving an event back when a reschedule's commit fails after Google already moved it.

## Phase 8 decisions (design and host pages)

### The design: A, "Editorial" (author's choice)

Three directions were mocked up (static pages, not committed): A Editorial (cream, deep green, large serif), B Bold neo-brutalist (thick borders, yellow and blue blocks), C Soft product (lilac, centred card). Screenshots and the reasons are in **docs/design/README.md**: A is calm and professional for someone booking a meeting, has the most identity, and is the furthest from both earlier projects. Two changes from the mockup, from the review:

1. **Time slots are real buttons** (`.slot`): a 2px border in the control colour, a tinted fill and accent border on hover, the focus ring, and a solid accent with light text when picked (`aria-pressed="true"`); at least 44px tall. The style is in the design system now; the booking page (phase 9) uses it.
2. **Serif for headings only, self-hosted:** Fraunces 600, Latin subset, from the `@fontsource/fraunces` npm package, so Vite bundles the file with the app and the browser never contacts a font service (checked in the browser: one 18 kB woff2 request to our own origin, no third-party requests; a test fails if any font-service URL appears in the page or styles). `font-display: swap` (the package's default) with a Georgia-based fallback stack. Body text is the system sans-serif, so it costs no download. (The package also ships a `.woff` fallback file in the build; no current browser fetches it.)

### Design tokens

`client/src/styles/tokens.css` holds every colour, font, size, space, the tap-target size (44px) and the focus ring; `app.css` uses only tokens. One light theme for now (the mockups had none; dark mode would mean a second set of colours, all of them re-checked).

**Contrast is checked in CI**, ported from the Study Scheduler: `client/scripts/checkContrast.ts` reads the colour tokens straight from `tokens.css` and checks the 31 pairs the components use (text and muted text 4.5:1 on every surface, links and buttons, status text on its own surface and on the page, and 3:1 for control edges and the focus ring). It runs as `npm run contrast`, a CI step, and part of `npm run check` (so the pre-push hook runs it too). All 31 pass; the lowest is control edges on the deep paper at 3.9:1.

### Host pages

Built on React Router with one auth provider (`/api/auth/me`; a 401 from any later call sends the host to `/login`), a `useApi` hook for the load/error/reload states, and shared components for the three non-ready states every page has: **loading** (a labelled spinner, `role="status"`), **error** (the server's message and Try again) and **empty** (what to do next). Every response is parsed with the shared Zod schema, and forms validate with the same shared schemas the API uses, so messages match.

- **Sign-in** (`/login`): Google (a full navigation, with the browser's time zone) and "Try as host"; the callback's `?error=` codes become plain messages (never the code or text from Google); after "Delete my account", what happened (Google access not revoked, events not removed).
- **Dashboard**: the warnings asked for in reviews, each with its action:
  - *Booking page not showing times* (phase 6 review): a new signed-in endpoint, **`GET /api/booking-page/status`**, runs the same busy lookup guests trigger through the same 60-second cache (so a dashboard visit costs at most one calendar read; tested), and on failure names the calendar or account and the fix: "can't be checked right now" (temporary, with Check again), "Reconnect Google" (access expired), or "untick it" (unreadable). It also reports whether hours and an active event type exist, for the setup prompts.
  - *Reconnect Google* for any account whose access expired: a link to the connect flow with that account preselected (`hint`).
  - *Cancelled, still on your calendar* (phase 7 review): those bookings listed apart from the upcoming ones, with Reconnect when access is the reason.
  - Upcoming bookings in the host's time zone, cancel with an inline confirmation, Show more (keyset pages); the booking links with Copy.
- **Calendars**: per account, its status (Reconnect when expired; Disconnect with confirmation, then whether Google access was revoked), each calendar's "counts as busy" box (disabled for unreadable ones, with the reason; "can't check right now" for unknown ones, where ticking checks again; the server's 409/503 message shown on the row), and "Put bookings here" for owned calendars. Refresh and Connect another account (not for the demo).
- **Availability**: time zone, weekly hours (any number of ranges a day, 15-minute steps, 24:00 for the end of the day), buffers, notice, horizon and the daily limit, saved together; overlaps are caught before sending with the server's own message. Below, **what guests see next week** for the first active event type, from the public slots endpoint (saved hours only).
- **Event types**: create (the link follows the title until edited), edit, turn on/off, delete with confirmation (the server's "has bookings, turn it off instead" shown), copy link.
- **Account**: profile, Sign out, and **Delete my account**: what will happen, then type the handle to enable the button; the demo explains why it can't be deleted.
- Not found and crash pages (a router error element) instead of a blank screen; a skip link; a Menu button for the navigation below 768px.

### Checked in the browser, at 1280px and 375px

Every page in its ready, loading, error and empty states (the latter three by having the page's own fetch answer slowly, fail or return nothing, then navigating within the app; the empty ones also for real, with a throwaway local host that was then deleted through the page). No page scrolls sideways at 375px in any state. Real flows run in the browser against the dev servers: demo sign-in and sign-out, creating an event type, and deleting an account (the database rows gone, the sign-in page saying what happened).

**Found by those checks and fixed:** the Menu button showed at desktop width (the button style's `display` won over the rule hiding it); the demo notice touched the next section; after "Delete my account", the host layout's own redirect to `/login` dropped the message saying what happened (it now travels with the signed-out state); and the API reported "couldn't revoke Google access" for a user with no Google account at all (nothing to revoke now counts as done; tested).

### Tests

66 client tests (Vitest, Testing Library, the real routes in a memory router against a mocked API): each page's loading, error and empty states; all three booking-page warnings and their links; reconnect; still-on-calendar listed apart; cancelling only after confirmation; refused ticks showing the server's reason; saving hours in one request and catching overlaps before it; event type links from titles; deleting an account only with the handle typed, then the sign-in page saying what happened; sign-out; signed-out visitors and a mid-visit 401 sent to sign-in; and the self-hosted font. Server: 7 more for the status endpoint, 1 for the account fix, 2 for the phase 7 gap.

## Phase 9 decisions (guest booking and manage pages)

### Routes, and what a guest's browser asks for

- The guest pages, **`/book/:handle/:slug`** and **`/booking/:token`**, sit outside the host's auth provider in the router, so a guest's visit never calls `/api/auth/me` (tested). The host routes are unchanged.
- **"Try booking"** on the sign-in page opens the demo host's 30-minute call (`DEMO_BOOKING_PATH`, from constants in `shared` that the demo data also uses; a test keeps them in step). The demo host is now also created on the first visit to its booking page, so the link works on a fresh database before anyone has pressed "Try as host" (tested).
- The event type info and the guest's booking say whether the host is the demo (`isDemo`), so the guest pages never promise an email the demo doesn't send.

### The booking page

- **Time zone:** detected from the browser and shown as "Kolkata (GMT+5:30)", with **Change time zone**: every zone the browser knows, listed and sorted by today's names. Chrome still reports some zones by old names (India as `Asia/Calcutta`), so labels use today's city, and a zone the browser lists under another name isn't listed twice. Opening the list moves focus to it.
- **Times** are in the guest's own language and clock (`Intl`, no locale forced); on a 24-hour clock the hour has two digits ("04:30"), since "4:30" next to "16:30" reads like the afternoon.
- **Only days with free times:** times are fetched in 42-day windows from the guest's today and grouped by the guest's own date (one moment can fall on different days in different zones; tested). The strip shows 7 such days at a time; Later fetches the next window when it reaches the end, then says "No more free times after these." With none at all: "No free times in the next six weeks".
- **Picking a time** opens the form for it and moves focus to its heading. When the host's clock shows a different time, the form says so ("That's 20:00 for Priya Sharma"), comparing clock times so another name for the same zone doesn't trigger it.
- **The form** checks name and email with the shared schema the API uses, shows each field's message, and moves focus to the first field to fix. Other failures (a 503 from Google) are shown in the form with everything kept.
- **"That time was just taken"** (409): the message, the times fetched again, the picked time cleared, the name and email kept for the next pick, and focus on the message (the form it was in has gone).
  - Server change, found in the browser: the API said "just taken" only when two requests met at the lock. The common case, another guest booking the time after this page loaded, failed the earlier check and got "That time isn't available". That check now says "just taken" when a booking overlaps the requested time; other reasons (notice, hours, horizon) still say "isn't available" (both tested, for booking and rescheduling).
- **Confirmation:** the time in the guest's zone (with the zone and offset), the manage link with a Copy button and a plain warning (it's the only way to cancel or reschedule, anyone with it can, and it isn't in the invitation), and what happens next (the invitation from Google, or for the demo that nothing is sent).

### The manage page

- The booking in the zone the guest booked in (stored with the booking), changeable; its status; Reschedule and Cancel booking.
- **Reschedule** reuses the day strip and time buttons. The Move button names the day as well as the time, since the guest may have paged to another week. A 409 is handled like the booking page's.
- **Cancel** asks first. A cancelled booking shows its time struck through and "Book a new time"; a meeting that has started can't be changed and says so; a link that matches nothing says "This link doesn't work" and where the link can be found.
- Focus follows the action: opening a panel focuses its heading, closing it returns to the button that opened it, and an outcome (moved, cancelled, taken) focuses its message.

### Keeping the manage link out of Referer headers and search engines

The token is in the page's URL, so three layers:

1. **The page's own response** carries `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow` for `/booking/*`: in production from **`vercel.json`** (a `headers` rule for `/booking/:token`), in development and `vite preview` from a small Vite plugin. Tests: the middleware sets both on `/booking/…` and nothing on other pages, and `vercel.json`'s values equal the shared `PRIVATE_PAGE_HEADERS`.
2. **Meta tags** (`referrer` and `robots`) added while the page is mounted and removed after, for arriving by in-app navigation, where no page request is made (tested).
3. **The API:** every `/api` response now has `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store` (Helmet already sent `Referrer-Policy: no-referrer`); tested on the manage endpoints.

All three were also confirmed on the dev servers' real responses.

### Checked in the browser, at 1280px and 375px

Loading, ready, time zone changes, form errors, a real "just taken" (a second guest booked the picked time through the API between picking and submitting), the confirmation, the manage view, rescheduling (including a real conflict), the move, cancel and its confirmation, cancelled, an invalid manage link and an unknown booking page; the empty and error states by stubbing the page's own fetch. No sideways scroll at 375px in any state. A started meeting needs a booking in the past, so it is covered by a test only.

**Found by those checks and fixed:** the zone list called India "Calcutta" and could list it twice; "4:30" on 24-hour clocks; focus lost after a conflict, after an invalid submit and when panels opened or closed; the server's message in the common conflict case; the Move button without a day; demo pages promising emails; the Earlier/Later and Copy links indented by their padding (Copy is now a bordered button, it being the one thing to do on that screen); day buttons 39px wide inside the reschedule panel on phones (the panel now runs edge to edge there: 46px); the manage page's message touching the heading and wider than the details (one 46rem column now); and the heading touching its text on the not-found and crash pages, host ones included.

### Tests

Client: 43 new, 110 in all. The component tests are the first in any of the three projects: slot selection (`SlotPicker`, `DayPicker`: pressed state, keyboard, paging, loading more), booking-form validation (required fields, a bad email, focus, tidied values, failures shown), and the time helpers. Page tests run the real routes against a mocked API: the booking page (zone detection and change, only days with times, booking and the confirmation, "just taken", other failures, empty, error with retry, loading, not found, demo wording) and the manage page (private-page meta tags, zones, cancel, reschedule, its conflict, demo wording, started, invalid link, loading, error); the header tests; and "Try booking". Server: 4 new (the "just taken" message, the API's headers, the demo booking page on a fresh database, the shared demo constants); one case moved from "isn't available" to "just taken".

## Phase 10 decisions (self-resetting demo)

`server/src/demo/resetDemo.ts`, the Study Scheduler's pattern:

- **When:** on a cold start (the first requests of a new server instance wait for it, so nobody sees a half-built demo; a failure is logged and the API carries on) and on "Try as host", and only if the last rebuild is **30 or more minutes** old. The time is in the database, a one-row **`DemoState`** table (a hand-written `CHECK (id = 1)`, in the constraints test), so every serverless instance agrees on when the next one is due. Most calls find it fresh with two primary-key reads and take no lock.
- **One rebuild at a time:** a transaction-scoped advisory lock. Whoever gets it checks again: of several requests that found the demo due at the same moment, the first rebuilds and the rest find it fresh and do nothing (tested: two at once give one rebuild).
- **Never in the middle of a booking change:** the rebuild also takes the demo host's booking lock, the one booking, moving and cancelling hold, so it waits for any change in progress (tested by holding that lock: the rebuild waits until it's released).
- **Everything a visitor can change is put back:** the host's settings and time zone, the booking calendar, which calendars count as busy, the weekly hours, the event types (added, edited, turned off or deleted), all bookings (made by guests or cancelled by the host) and their calendar events, and the busy cache. The test changes every one of these through the API, checks a demo login 29 minutes later changes nothing, and that one at 30 minutes restores a snapshot equal to the fresh demo.
- **Stable ids:** the host, the connection, the three calendars and the three event types keep their ids, so links and the "Try booking" page never change (tested). The host row is updated, not deleted, so visitors stay signed in through a rebuild and simply see the fresh demo. A guest's manage link from before a rebuild stops working ("This link doesn't work"); acceptable for a demo, and the dashboard already says it resets.
- **Busy events** are regenerated around the day of the rebuild: from the day before through the end of the 30-day booking horizon, plus a day for guests in zones ahead of Priya's (it was three weeks in phase 3, which left the last nine bookable days empty). Deterministic per date, as before.
- **"Try booking" never resets:** the booking page only builds the demo if it doesn't exist (a fresh database), so a guest never has the demo rebuilt under them. A missing demo host counts as never built, whatever `DemoState` says.
- **Demo bookings never contact Google:** they go through the demo provider, which writes demo events in Postgres. Tested with a fake Google configured: booking, moving, cancelling and the host's cancel make no request to it at all. They don't count toward the daily booking limit (the existing test now also checks the client's count is unchanged). Demo accounts still can't connect a Google account (phase 4 test).
- **Found while doing this:** the demo's handle `priya` wasn't reserved. On a fresh production database, a real person named Priya signing in first would have got it, making "Try booking" open their page and the demo impossible to build. Real accounts now never get the demo's handle (they get `priya-xxxxx`; tested).

**Mutation checks:** 14 deliberate bugs, one at a time. 13 were caught: no re-check under the lock, no reset lock, no booking lock, `>` for `>=` at 30 minutes, settings not restored, bookings kept, busy cache kept, busy events only three weeks, "Try booking" resetting a stale demo, a missing host not noticed, the cold-start check on every request, the cold start not awaited, and the handle not reserved. The 14th (not clearing the booking calendar) was an equivalent mutant, since deleting the calendars already clears it (`ON DELETE SET NULL`), so that line was removed.

Checked live on the dev servers: the restarted API rebuilt the never-reset demo on its first request; an event type turned off in the browser stayed off until `DemoState` was made 31 minutes old, then came back on the next "Try as host".

## Phase 11 decisions (README and end-to-end test)

### The end-to-end test (`e2e/`)

- **What it runs:** the production build of the client (`vite preview`, which now proxies `/api` like the dev server, tested) against the ordinary API server and a real Postgres database, on ports of its own (web 5290, API 4300) so it never meets the dev servers. Playwright starts both (`e2e/startApi.ts` migrates the database with `migrate deploy`, as production is migrated, and empties it first, so every run starts with a never-built demo and no rate-limit counts).
- **Its own database:** `E2E_DATABASE_URL` (CI), or locally the test database's name with `_e2e` instead of `_test` (Prisma creates it on the first run). Like the unit tests' guard, it refuses any database whose name doesn't end in `_e2e`, since it empties it.
- **The flow:** "Try booking" -> the booking page in the guest's zone (London, en-GB, fixed in the config so the machine's settings don't matter) -> pick the first time -> the form's own validation -> book -> the confirmation (time in the guest's zone, demo wording, focus on the heading) -> the manage page (its `no-referrer` and `noindex` headers and meta tag checked on the real response) -> cancel after confirming -> the time is free again. A second test signs in with "Try as host" and visits every host page.
- **Accessibility:** axe (`@axe-core/playwright`, WCAG 2.0/2.1/2.2 A and AA rules) on every screen of both tests, plus "nothing scrolls sideways". Everything passed on the first run. Checked that the check bites: removing `lang` from `index.html` fails it with `html-has-lang`.
- **Both widths:** each test runs as a 1280px desktop and as a 375px touch phone (two Playwright projects), one at a time since they share the demo.
- **In CI** as a second job (Postgres service, `npx playwright install --with-deps chromium`, the report and traces uploaded when it fails), and **in the pre-push hook** after `npm run check`, so no commit is pushed without it.

### Screenshots and README

- `docs/screenshots/` are taken from the real app by Playwright (`npm run screenshots`, a separate config that reuses the test's servers; each shot waits for its page's content so it never catches a spinner). Retaken on the live site in phase 12 (`LIVE_URL=<site> npm run screenshots`), so the booking links show its real address.
- The README is written for recruiters: the demo story, features, Mermaid diagrams of the architecture, the Google sign-in sequence and the booking flow (checked to render with Mermaid 11), the slot algorithm with its worked example, the CalendarProvider interface and why it exists, privacy and security, design decisions, known trade-offs (plus "demo bookings don't survive a demo reset"), the testing approach, running locally, and the hook. The live link is a placeholder until phase 12.

## Phase 12 decisions (deployment)

**Live: <https://calendar-aggregator-beta.vercel.app>** (Vercel added "-beta" because `calendar-aggregator.vercel.app` belongs to someone else, as it added "-green" for the Study Scheduler).

### One Vercel project, from the command line

- **Project `calendar-aggregator`** (team seshasais-projects), created and deployed with the Vercel CLI; no Git connection yet, so deployments happen with `vercel deploy` (connecting the GitHub repo for automatic deployments is in the author's checklist). Node 24.x, region `iad1` (Washington, D.C.).
- **`vercel.json`:** `npm ci`; build `node server/scripts/vercelBuild.ts`; static output `client/dist`; the API function `api/index.ts` with **`maxDuration: 60`** (what `FUNCTION_MAX_DURATION_S` assumes; a test checks they match); rewrites `/api/(.*)` -> the function and everything else -> `index.html` (static files are served first); the manage pages' headers.
- **`api/index.ts`** only calls `createVercelApp()` (`server/src/vercel.ts`, tested): the ordinary app with the cold-start demo reset on. It answers a plain 503 instead of starting when settings are missing (their names are logged, never values), and when it's a preview without a database of its own.

### TypeScript on Vercel: Vercel's own compilation, plus the shared sources

Checked on a preview: Vercel's Node builder **compiles the server's `.ts` files to JavaScript itself** (no build step of ours), but it didn't include the **`shared` workspace package**: the API crashed with `ERR_MODULE_NOT_FOUND` for `node_modules/@calendar-aggregator/shared/src/slots/index.ts`, because the package's `exports` point at `.ts` sources the function bundle didn't carry. Fix: `"includeFiles": "shared/src/**"` on the function, so those files ship and Node 24's type stripping runs them (they're reached through the workspace symlink, outside `node_modules`, where Node allows it). The whole API then loaded, and every live check below passed. Chosen over a bundling step (esbuild, or Vercel's Build Output API): one line of configuration instead of a second way of building the server, and development, tests and production still run the same source files. Prisma's query engine was bundled without any `includeFiles` (queries work live).

### Neon: pooled for the app, direct for migrations, production only

- A new Neon database **`calendar-aggregator-db`** through the Neon integration already installed on the Vercel team (the Study Scheduler's), on the **Free plan** (`free_v3`), region `iad1` next to the function, without Neon Auth (the app has its own sign-in). Connected to the **Production environment only**, so previews and development get none of its settings (checked with `vercel env ls`).
- **The app uses `DATABASE_URL`, Neon's pooled connection** (PgBouncer in transaction mode): every lock the app takes is transaction-scoped (`pg_advisory_xact_lock`, `SET LOCAL`), so they work through the pooler, and Neon's pooler supports Prisma's prepared statements (no errors in the live tests).
- **Migrations run during the production build over `DATABASE_URL_UNPOOLED`**, the direct connection (`prisma migrate deploy` needs a session). `vercelBuild.ts` refuses to migrate from anything but production unless `PREVIEW_HAS_OWN_DATABASE=true` (for a future Neon branch per preview), and fails the build if production has no direct URL (tested; it's what stopped the first deployment, which Vercel made a production one before the database existed).
- **Previews are isolated twice:** they have no database settings at all, and even if they were given some, `createVercelApp` switches their API off (`isPreviewWithoutOwnDatabase`, tested; seen live: a preview's `/api/health` answers 503 "This preview deployment has no database of its own").

### Secrets

`COOKIE_SIGNING_SECRET` and `TOKEN_ENCRYPTION_KEYS` (`1:<key>`) were generated locally (32 random bytes each) and, with the existing OAuth client's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from `server/.env`, sent to `vercel env add ... production --sensitive` on stdin by a short script that printed only names: never shown, never in a command line, never in a file in the repo. Sensitive variables can't be read back from Vercel. `APP_ORIGIN` is the production URL (not secret). The CLI's `vercel link` also wrote a short-lived `VERCEL_OIDC_TOKEN` to `.env.local` and appended `.env*` to `.gitignore`; the file was deleted (the app doesn't use it) and the `.gitignore` edit undone (it would have re-ignored the committed `.env.example` files). The CLI also downloaded Neon "agent skills" into the repo, which were removed.

### Checked on the live site

- `/api/health` 200; Prisma through the pooler; the cold-start demo build.
- **Client address for the rate limiters:** with `LOG_CLIENT_IP=true` for one deployment, every request logged the same visitor address as `req.ip`, the limiters' key and Vercel's `x-real-ip`; a request sending a forged `X-Forwarded-For: 198.51.100.77` never showed that address (Vercel's edge overwrites the header, and one trusted hop takes the address it wrote). Then **IP logging was turned off**: the variable removed, redeployed, and no address lines since. The flag (`logClientIp`) stays in the code, off by default, for the next such check.
- **Private-page headers:** `/booking/<token>` has `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow`; `/book/priya/30-min-call` has neither.
- **Demo:** "Try as host" (session cookie `__Host-` prefixed, Secure), the dashboard's status endpoint and event types; a guest booking -> the manage view -> reschedule -> cancel -> cancel again (idempotent), through the API.
- **The end-to-end tests against the live site** (`LIVE_URL=https://calendar-aggregator-beta.vercel.app npm run e2e:live`, new): the guest flow and every host page at 1280px and 375px, with axe: all 4 passed.
- **Google sign-in** starts correctly (S256 PKCE, the six scopes, `__Host-` flow cookie, `redirect_uri` `https://calendar-aggregator-beta.vercel.app/api/auth/google/callback`); finishing it needs that URI registered in Google Cloud Console (author).

### Phase 12 checklist

- [x] API function maximum duration 60 s (`vercel.json`; tested against `FUNCTION_MAX_DURATION_S`).
- [x] Private-page headers on the live site (above).
- [x] Server `.ts` files on Vercel: Vercel compiles them; the `shared` sources ship with `includeFiles` (above).
- [x] Prisma's query engine bundled in the workspace layout, without `includeFiles` (queries work live).
- [x] Client address read correctly for the rate limiters, then IP logging off (above).
- [ ] **Author:** in Google Cloud Console > Clients > the web client, add the redirect URI `https://calendar-aggregator-beta.vercel.app/api/auth/google/callback` (docs/google-setup.md, step 6). Until then, "Sign in with Google" on the live site ends at Google's `redirect_uri_mismatch` page; the demo works without it.
- [ ] **Author:** in Google Cloud Console > Data Access, replace `calendar.freebusy` with `calendar.events.freebusy` (the local test client was set up before the phase 5 switch; Testing mode doesn't need it, verification does).
- [ ] **Author:** optionally connect the GitHub repo to the Vercel project (Vercel dashboard > calendar-aggregator > Settings > Git) for automatic deployments on push. Previews made that way are safe: no database settings, and their API switches itself off.
- [ ] **Author:** the real-phone test: open the live link on a phone, "Try booking", book, open the manage link, cancel; and "Try as host".

## After phase 12: link previews

`client/index.html` has a meta description, Open Graph tags and a Twitter/X `summary_large_image` card, so a shared link shows a title, a description and a picture. The picture is the booking page with a time picked (`client/public/og-image.png`, 1200x630, the size Open Graph and X expect, taken by `npm run screenshots`), served from the site itself; every URL in the tags is absolute on the live domain. Because the app is a single page, every route gets the same tags: a shared manage link never puts its token into a preview. A test checks the tags agree, point at our own domain (the README's live link), and that the image exists at the declared size.

## Notes for later phases

- **Client bundle** is ~390 kB before gzip (465 kB now), mostly Zod and react-router; revisit (e.g. `zod/mini` on the client).
- **`npm audit`** reports 3 high-severity advisories in `deepmerge-ts`, used by the Prisma CLI's config loader (`prisma` 6.13+), not by the app at runtime; npm's only offered fix is a breaking Prisma downgrade, so it's left until Prisma ships a fixed dependency.
