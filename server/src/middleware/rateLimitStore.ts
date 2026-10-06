import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import type { Db } from '../db.ts';

// An express-rate-limit store that keeps hit counts in Postgres (the RateLimit table), so every
// server instance shares them. An in-memory store would give each serverless instance its own
// counts, and they would vanish whenever an instance stops. (Ported from the Study Scheduler.)
//
// Each hit is one atomic statement, so concurrent requests on different instances never lose a
// count. Rows whose window has ended are deleted as requests come in (at most once per window per
// instance): serverless instances have no reliable background timer to do it.
export class PostgresStore implements Store {
  // Counts are shared between instances (express-rate-limit uses this for its double-count check).
  readonly localKeys = false;
  readonly prefix: string;
  readonly #db: Db;
  #windowMs = 0;
  #lastCleanupMs = 0;

  // prefix keeps each limiter's counts apart in the shared table ("demo-login:", ...).
  constructor({ db, prefix }: { db: Db; prefix: string }) {
    this.#db = db;
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.#windowMs = options.windowMs;
  }

  #rowKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const row = await this.#db.rateLimit.findUnique({ where: { key: this.#rowKey(key) } });
    if (!row || Number(row.resetAtMs) <= Date.now()) return undefined;
    return { totalHits: row.hits, resetTime: new Date(Number(row.resetAtMs)) };
  }

  // Counts a hit. A client's first hit, or the first after their window ended, starts a new window.
  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = Date.now();
    await this.#cleanUp(now);
    const nowMs = BigInt(now);
    const rows = await this.#db.$queryRaw<{ hits: number; resetAtMs: bigint }[]>`
      INSERT INTO "RateLimit" ("key", "hits", "resetAtMs")
      VALUES (${this.#rowKey(key)}, 1, ${nowMs + BigInt(this.#windowMs)})
      ON CONFLICT ("key") DO UPDATE SET
        "hits" = CASE WHEN "RateLimit"."resetAtMs" <= ${nowMs} THEN 1 ELSE "RateLimit"."hits" + 1 END,
        "resetAtMs" = CASE WHEN "RateLimit"."resetAtMs" <= ${nowMs}
          THEN EXCLUDED."resetAtMs" ELSE "RateLimit"."resetAtMs" END
      RETURNING "hits", "resetAtMs"`;
    const row = rows[0];
    if (!row) throw new Error('Rate limit upsert returned no row');
    return { totalHits: row.hits, resetTime: new Date(Number(row.resetAtMs)) };
  }

  // Takes a hit back (for limiters that only count failed requests).
  async decrement(key: string): Promise<void> {
    await this.#db.$executeRaw`
      UPDATE "RateLimit" SET "hits" = "hits" - 1
      WHERE "key" = ${this.#rowKey(key)} AND "hits" > 0 AND "resetAtMs" > ${BigInt(Date.now())}`;
  }

  async resetKey(key: string): Promise<void> {
    await this.#db.rateLimit.deleteMany({ where: { key: this.#rowKey(key) } });
  }

  // Deletes every client's row whose window has ended (for all limiters), so the table only holds
  // clients seen within the last window.
  async #cleanUp(now: number): Promise<void> {
    if (now - this.#lastCleanupMs < this.#windowMs) return;
    this.#lastCleanupMs = now;
    await this.#db.$executeRaw`DELETE FROM "RateLimit" WHERE "resetAtMs" <= ${BigInt(now)}`;
  }
}
