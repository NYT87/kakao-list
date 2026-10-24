import type {
  ClientRateLimitInfo,
  IncrementResponse,
  Options,
  Store,
} from "express-rate-limit";
import type { Pool } from "pg";

// Shared store for express-rate-limit. The server runs as serverless
// functions, so the library's default in-memory store would give every
// instance its own counters; Postgres is already shared and deployed.
//
// Fixed windows aligned to multiples of windowMs. One row per limiter key,
// updated with a single atomic upsert, so concurrent hits are each counted
// once. Expired rows are deleted by the maintenance job.

export const RATE_LIMIT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key TEXT PRIMARY KEY,
    window_start TIMESTAMPTZ NOT NULL,
    reset_at TIMESTAMPTZ NOT NULL,
    hits INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS rate_limit_buckets_reset_idx
    ON rate_limit_buckets (reset_at);
`;

export class PostgresRateLimitStore implements Store {
  windowMs = 60_000;
  /** Keys are stored server-side, shared by every instance. */
  localKeys = false;

  constructor(
    private readonly pool: Pool,
    readonly prefix: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const result = await this.pool.query<{ hits: number; reset_at: Date }>(
      `
        SELECT hits, reset_at FROM rate_limit_buckets
        WHERE bucket_key = $1 AND window_start = $2
      `,
      [this.prefix + key, this.currentWindow().start],
    );
    const row = result.rows[0];
    return row ? { totalHits: row.hits, resetTime: row.reset_at } : undefined;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const { start, reset } = this.currentWindow();
    // A row from an older window restarts at 1. GREATEST keeps a newer
    // window that a concurrent request already wrote.
    const result = await this.pool.query<{ hits: number; reset_at: Date }>(
      `
        INSERT INTO rate_limit_buckets (bucket_key, window_start, reset_at, hits)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (bucket_key) DO UPDATE SET
          hits = CASE
            WHEN rate_limit_buckets.window_start >= EXCLUDED.window_start
              THEN rate_limit_buckets.hits + 1
            ELSE 1
          END,
          window_start = GREATEST(rate_limit_buckets.window_start, EXCLUDED.window_start),
          reset_at = GREATEST(rate_limit_buckets.reset_at, EXCLUDED.reset_at)
        RETURNING hits, reset_at
      `,
      [this.prefix + key, start, reset],
    );
    const row = result.rows[0] as { hits: number; reset_at: Date };
    return { totalHits: row.hits, resetTime: row.reset_at };
  }

  async decrement(key: string) {
    await this.pool.query(
      `
        UPDATE rate_limit_buckets SET hits = GREATEST(hits - 1, 0)
        WHERE bucket_key = $1 AND window_start = $2
      `,
      [this.prefix + key, this.currentWindow().start],
    );
  }

  async resetKey(key: string) {
    await this.pool.query(
      "DELETE FROM rate_limit_buckets WHERE bucket_key = $1",
      [this.prefix + key],
    );
  }

  private currentWindow() {
    const nowMs = this.now().getTime();
    const startMs = nowMs - (nowMs % this.windowMs);
    return {
      start: new Date(startMs),
      reset: new Date(startMs + this.windowMs),
    };
  }
}
