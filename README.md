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
