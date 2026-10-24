import assert from "node:assert/strict";
import crypto from "node:crypto";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import type { Options } from "express-rate-limit";
import { Pool } from "pg";
import {
  PostgresRateLimitStore,
  RATE_LIMIT_SCHEMA_SQL,
} from "./rateLimitStore.js";

// Runs only when TEST_DATABASE_URL is set (see agentTokens.postgres.test.ts).
const databaseUrl = process.env.TEST_DATABASE_URL;
const WINDOW_MS = 60_000;

describe("Postgres rate limit store", { skip: !databaseUrl }, () => {
  const schema = `rate_limit_test_${crypto.randomBytes(4).toString("hex")}`;
  let pool: Pool;
  let clock = new Date("2026-10-24T00:00:10.000Z");

  function createStore(prefix: string) {
    const store = new PostgresRateLimitStore(pool, prefix, () => clock);
    store.init({ windowMs: WINDOW_MS } as Options);
    return store;
  }

  before(async () => {
    const setup = new Pool({ connectionString: databaseUrl });
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.end();
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    await pool.query(RATE_LIMIT_SCHEMA_SQL);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  it("counts hits per key within a window and reports the reset time", async () => {
    const store = createStore("count:");

    const first = await store.increment("1.2.3.4");
    const second = await store.increment("1.2.3.4");
    const other = await store.increment("5.6.7.8");

    assert.equal(first.totalHits, 1);
    assert.equal(second.totalHits, 2);
    assert.equal(other.totalHits, 1);
    assert.equal(second.resetTime?.toISOString(), "2026-10-24T00:01:00.000Z");
  });

  it("keeps limiters with different prefixes apart", async () => {
    const token = createStore("token:");
    const register = createStore("register:");

    await token.increment("same-key");
    await token.increment("same-key");

    assert.equal((await register.increment("same-key")).totalHits, 1);
  });

  it("starts a new count in the next window", async () => {
    const store = createStore("window:");
    await store.increment("key");
    await store.increment("key");

    clock = new Date(clock.getTime() + WINDOW_MS);
    const next = await store.increment("key");

    assert.equal(next.totalHits, 1);
  });

  it("counts every concurrent hit exactly once", async () => {
    const store = createStore("concurrent:");

    const results = await Promise.all(
      Array.from({ length: 25 }, () => store.increment("busy")),
    );

    assert.deepEqual(
      results.map((result) => result.totalHits).sort((a, b) => a - b),
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it("supports get, decrement and resetKey", async () => {
    const store = createStore("ops:");
    await store.increment("key");
    await store.increment("key");

    await store.decrement("key");
    assert.equal((await store.get("key"))?.totalHits, 1);

    await store.resetKey("key");
    assert.equal(await store.get("key"), undefined);
  });

  it("does not report a previous window's hits", async () => {
    const store = createStore("stale:");
    await store.increment("key");

    clock = new Date(clock.getTime() + WINDOW_MS);

    assert.equal(await store.get("key"), undefined);
  });
});
