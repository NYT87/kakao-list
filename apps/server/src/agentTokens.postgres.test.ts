import assert from "node:assert/strict";
import crypto from "node:crypto";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import {
  AGENT_TOKEN_LIST_LIMIT,
  AGENT_TOKENS_SCHEMA_SQL,
  type AgentTokenStore,
  createPostgresAgentTokenStore,
  type NewAgentTokenRecord,
} from "./agentTokens.js";

// Runs only when TEST_DATABASE_URL is set, e.g.
// TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/kakao_lists
// Each run uses its own schema and drops it afterwards.
const databaseUrl = process.env.TEST_DATABASE_URL;

describe("Postgres agent token store", { skip: !databaseUrl }, () => {
  const schema = `agent_tokens_test_${crypto.randomBytes(4).toString("hex")}`;
  let pool: Pool;
  let store: AgentTokenStore;
  const now = new Date("2026-10-24T00:00:00.000Z");

  function newToken(overrides: Partial<NewAgentTokenRecord> = {}) {
    return {
      id: crypto.randomUUID(),
      kakaoUserId: "user-1",
      name: "Claude",
      tokenHash: crypto.randomBytes(32).toString("hex"),
      tokenHint: "kl_pat_…abcd",
      scopes: ["lists:read"],
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      ...overrides,
    };
  }

  before(async () => {
    const setup = new Pool({ connectionString: databaseUrl });
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.end();
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    await pool.query(AGENT_TOKENS_SCHEMA_SQL);
    store = createPostgresAgentTokenStore(pool);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  it("creates and finds a usable token by hash", async () => {
    const token = newToken();
    const created = await store.createIfBelowLimit(token, 10);

    assert.equal(created?.id, token.id);
    assert.deepEqual(created?.scopes, ["lists:read"]);
    assert.equal(created?.expiresAt, token.expiresAt.toISOString());
    assert.equal(
      (await store.findUsableByHash(token.tokenHash, now))?.id,
      token.id,
    );
  });

  it("does not find expired tokens", async () => {
    const token = newToken({ expiresAt: now });
    await store.createIfBelowLimit(token, 10);

    assert.equal(await store.findUsableByHash(token.tokenHash, now), null);
  });

  it("enforces the limit even with concurrent requests", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.createIfBelowLimit(newToken({ kakaoUserId: userId }), 3),
      ),
    );

    assert.equal(results.filter(Boolean).length, 3);
    assert.equal((await store.listForUser(userId, now)).length, 3);
  });

  it("revokes only tokens owned by the user", async () => {
    const token = newToken({ kakaoUserId: "owner" });
    await store.createIfBelowLimit(token, 10);

    assert.equal(await store.revoke("someone-else", token.id, now), false);
    assert.equal(await store.revoke("owner", token.id, now), true);
    assert.equal(await store.revoke("owner", token.id, now), false);
    assert.equal(await store.findUsableByHash(token.tokenHash, now), null);
    assert.deepEqual(await store.listForUser("owner", now), []);
  });

  it("lists an older active token before newer expired ones", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const active = newToken({
      kakaoUserId: userId,
      expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
    });
    await store.createIfBelowLimit(active, 10);
    for (let index = 1; index <= AGENT_TOKEN_LIST_LIMIT; index += 1) {
      const createdAt = new Date(now.getTime() + index * 1000);
      await store.createIfBelowLimit(
        newToken({ kakaoUserId: userId, createdAt, expiresAt: createdAt }),
        10,
      );
    }
    const later = new Date(now.getTime() + 1000 * 1000);

    const listed = await store.listForUser(userId, later);

    assert.equal(listed.length, AGENT_TOKEN_LIST_LIMIT);
    assert.equal(listed[0]?.id, active.id);
    assert.ok(
      listed
        .slice(1)
        .every((token) => Date.parse(token.expiresAt) <= later.getTime()),
    );
  });

  it("throttles last-used updates", async () => {
    const token = newToken({ kakaoUserId: "throttle" });
    await store.createIfBelowLimit(token, 10);
    const soon = new Date(now.getTime() + 1_000);

    await store.markUsed(token.id, now, 60_000);
    await store.markUsed(token.id, soon, 60_000);

    const [listed] = await store.listForUser("throttle", now);
    assert.equal(listed?.lastUsedAt, now.toISOString());
  });
});
