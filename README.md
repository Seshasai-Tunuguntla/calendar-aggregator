# Calendar Aggregator

Sign in with Google, combine your calendars' busy times with your working hours, and share
booking links: a guest picks a free slot in their own time zone and the event lands on your Google
Calendar, like a small Calendly. A TypeScript full-stack portfolio project (React, Express, Prisma,
Postgres).

Work in progress: [docs/PLAN.md](docs/PLAN.md) has the brief, the decisions made so far and the
status of each phase. The full README (demo, architecture, screenshots) comes in phase 11.

## Development

### You need

- Node.js 24 (LTS). The server runs its TypeScript directly with Node's type stripping; no build step.
- PostgreSQL (CI uses 17, as Neon does in production; any recent version works locally).

### Set up

```bash
npm install
```

Installs all three workspaces (`shared`, `server`, `client`), generates the Prisma client, and
installs the git pre-push hook (see below).

```bash
createdb calendar_aggregator && createdb calendar_aggregator_test
```

Then copy `server/.env.example` to `server/.env` and `server/.env.test.example` to
`server/.env.test`, and adjust the database user if needed. The test database's name must end in
`_test`: the tests refuse to migrate or empty anything else.

```bash
npm run db:migrate --workspace server
```

Google sign-in is optional locally (the demo works without it). To turn it on, follow
[docs/google-setup.md](docs/google-setup.md).

### Run

```bash
npm run dev:server
```

```bash
npm run dev:client
```

Open <http://localhost:5190>. The client proxies `/api` to the API on port 4200, so the browser
sees one origin, as in production.

### Check

```bash
npm run check
```

Runs everything CI runs: typecheck, lint (warnings fail it), the tests of all three workspaces
(the server's against the test database), and the client build.

### The pre-push hook

`npm install` points git at `.githooks/`, whose `pre-push` hook runs `npm run check` and blocks
the push if anything fails. It exists because a commit that failed CI's lint step once reached
GitHub (`e5aa897`): the hook catches that before pushing, not after.

- It checks your working folder, so it first requires that folder to be clean (commit or stash
  first) and that you're pushing the commit you have checked out. Otherwise it could pass on code
  that isn't the code being pushed. Like CI, it checks the tip of each push.
- It needs the local test database (see "Set up").
- `git push --no-verify` skips it. Don't, unless it's an emergency: CI runs the same checks anyway,
  and a failing commit stays in the history.
- If hooks aren't running, `npm run prepare` reinstalls them (it sets `git config core.hooksPath .githooks`).

### Rotating the token encryption key

Put the new key first in `TOKEN_ENCRYPTION_KEYS` (`"2:<new>,1:<old>"`), deploy, run
`npm run tokens:reencrypt --workspace server`, then remove the old key. Details in
[docs/PLAN.md](docs/PLAN.md), "Phase 4 decisions".

## Known trade-offs

- **Holidays don't block bookings.** Google's free/busy service can't read holiday calendars (checked on a real account; see "Free/busy scope" in [docs/PLAN.md](docs/PLAN.md)), and the app doesn't request the extra permission that reading their events would need (`calendar.events.public.readonly`, "See the events on public calendars"). To keep a holiday free, add it as an event or out-of-office on your own calendar; that does block bookings.
- **At most 10 bookings per day from one connection.** Every booking makes Google email an invitation to whatever address the guest typed, so each client (IP address) can make at most 10 successful bookings a day with real hosts, on top of 10 booking changes per 15 minutes. People booking from the same office or mobile network share that allowance. Demo bookings send no email and don't count.
- **A booking can't be moved to a time that overlaps its current one** (for example 15 minutes later, for a 30-minute meeting). The host's calendar still shows the meeting at its old time while it's being moved, and Google's free/busy answer gives only busy time ranges, not which event each range came from, so the app can't leave the meeting's own event out without risking ignoring another event that overlaps it. Cancelling and booking the new time works.
