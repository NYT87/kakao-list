import assert from "node:assert/strict";
import crypto from "node:crypto";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import {
  createPostgresOAuthStore,
  type NewOAuthToken,
  OAUTH_GRANT_LIST_LIMIT,
  OAUTH_SCHEMA_SQL,
  type OAuthStore,
} from "./oauthStore.js";

// Runs only when TEST_DATABASE_URL is set (see agentTokens.postgres.test.ts).
// Each run uses its own schema and drops it afterwards.
const databaseUrl = process.env.TEST_DATABASE_URL;
const MINUTE = 60 * 1000;

describe("Postgres OAuth store", { skip: !databaseUrl }, () => {
  const schema = `oauth_test_${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date("2026-10-24T00:00:00.000Z");
  let pool: Pool;
  let store: OAuthStore;

  const hash = () => crypto.randomBytes(32).toString("hex");
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

  function token(
    kind: NewOAuthToken["kind"],
    overrides: Partial<NewOAuthToken> = {},
  ): NewOAuthToken {
    return {
      tokenHash: hash(),
      kind,
      scopes: ["lists:read"],
      createdAt: now,
      expiresAt: at(kind === "access" ? 60 * MINUTE : 30 * 24 * 60 * MINUTE),
      ...overrides,
    };
  }

  async function saveCode(
    overrides: { kakaoUserId?: string; createdAt?: Date } = {},
  ) {
    const createdAt = overrides.createdAt ?? now;
    const codeHash = hash();
    await store.saveAuthorizationCode({
      codeHash,
      clientId: "client-1",
      clientName: "Claude",
      kakaoUserId: overrides.kakaoUserId ?? "user-1",
      redirectUri: "http://localhost:4567/cb",
      codeChallenge: "challenge",
      scopes: ["lists:read"],
      resource: "https://api.example/mcp",
      createdAt,
      expiresAt: new Date(createdAt.getTime() + MINUTE),
    });
    return codeHash;
  }

  function redeem(
    codeHash: string,
    options: { createdAt?: Date; expiresAt?: Date } = {},
    maxActive = 20,
  ) {
    const access = token("access");
    const refresh = token("refresh");
    const createdAt = options.createdAt ?? now;
    const result = store.redeemAuthorizationCode(
      codeHash,
      createdAt,
      (code) => ({
        grant: {
          id: crypto.randomUUID(),
          kakaoUserId: code.kakaoUserId,
          clientId: code.clientId,
          clientName: code.clientName,
          scopes: code.scopes,
          resource: code.resource,
          createdAt,
          expiresAt: options.expiresAt ?? at(30 * 24 * 60 * MINUTE),
        },
        tokens: [access, refresh],
      }),
      maxActive,
    );
    return { result, access, refresh };
  }

  async function createGrant(
    options: { kakaoUserId?: string; createdAt?: Date; expiresAt?: Date } = {},
    maxActive = 20,
  ) {
    const codeHash = await saveCode(options);
    const { result, access, refresh } = redeem(codeHash, options, maxActive);
    const redeemed = await result;
    const grant = redeemed.status === "ok" ? redeemed.grant : null;
    return { grant, access, refresh, codeHash };
  }

  before(async () => {
    const setup = new Pool({ connectionString: databaseUrl });
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.end();
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    await pool.query(OAUTH_SCHEMA_SQL);
    store = createPostgresOAuthStore(pool);
    await store.saveClient(
      { client_id: "client-1", redirect_uris: ["http://localhost:4567/cb"] },
      now,
    );
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  it("stores and reads back registered clients", async () => {
    const client = {
      client_id: crypto.randomUUID(),
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
    };
    await store.saveClient(client, now);

    assert.deepEqual(await store.getClient(client.client_id), client);
    assert.equal(await store.getClient("missing"), null);
  });

  it("lets one caller claim a pending sign-in, which stays stored until completed", async () => {
    const pending = {
      idHash: hash(),
      clientId: "client-1",
      clientName: "Claude",
      redirectUri: "http://localhost:4567/cb",
      codeChallenge: "challenge",
      state: "client-state",
      scopes: ["lists:read"],
      resource: "https://api.example/mcp",
      createdAt: now,
      expiresAt: at(10 * MINUTE),
    };
    await store.savePendingAuthorization(pending);

    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.claimPendingAuthorization(pending.idHash, now),
      ),
    );

    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claims.find(Boolean)?.state, "client-state");
    // Claimed, not consumed: it still protects its client from cleanup.
    assert.ok(await store.findPendingAuthorization(pending.idHash, now));
    assert.ok(
      await store.completePendingAuthorization(pending.idHash, now, null),
    );
    assert.equal(
      await store.claimPendingAuthorization(pending.idHash, now),
      null,
    );
  });

  it("refuses to save a pending sign-in for a client that no longer exists", async () => {
    const idHash = hash();

    const saved = await store.savePendingAuthorization({
      idHash,
      clientId: "deleted-client",
      clientName: "Claude",
      redirectUri: "http://localhost:4567/cb",
      codeChallenge: "challenge",
      state: null,
      scopes: ["lists:read"],
      resource: "https://api.example/mcp",
      createdAt: now,
      expiresAt: at(10 * MINUTE),
    });

    assert.equal(saved, false);
    assert.equal(await store.findPendingAuthorization(idHash, now), null);
  });

  it("does not complete a pending sign-in nobody claimed", async () => {
    const idHash = hash();
    await store.savePendingAuthorization({
      idHash,
      clientId: "client-1",
      clientName: "Claude",
      redirectUri: "http://localhost:4567/cb",
      codeChallenge: "challenge",
      state: null,
      scopes: ["lists:read"],
      resource: "https://api.example/mcp",
      createdAt: now,
      expiresAt: at(10 * MINUTE),
    });

    assert.equal(
      await store.completePendingAuthorization(idHash, now, null),
      null,
    );
    assert.ok(await store.findPendingAuthorization(idHash, now));
  });

  it("completes a pending sign-in once, atomically with its code", async () => {
    const pending = {
      clientId: "client-1",
      clientName: "Claude",
      redirectUri: "http://localhost:4567/cb",
      codeChallenge: "challenge",
      state: "client-state",
      scopes: ["lists:read"],
      resource: "https://api.example/mcp",
      createdAt: now,
      expiresAt: at(10 * MINUTE),
    };
    const fresh = { ...pending, idHash: hash() };
    const stale = { ...pending, idHash: hash() };
    await store.savePendingAuthorization(fresh);
    await store.savePendingAuthorization(stale);

    // Looking it up does not consume it.
    assert.equal(
      (await store.findPendingAuthorization(fresh.idHash, now))?.state,
      "client-state",
    );
    assert.ok(await store.findPendingAuthorization(fresh.idHash, now));
    assert.ok(await store.claimPendingAuthorization(fresh.idHash, now));

    const codeFor = (codeHash: string) => ({
      codeHash,
      clientId: "client-1",
      clientName: "Claude",
      kakaoUserId: "user-1",
      redirectUri: "http://localhost:4567/cb",
      codeChallenge: "challenge",
      scopes: ["lists:read"],
      resource: "https://api.example/mcp",
      createdAt: now,
      expiresAt: at(MINUTE),
    });
    const codeHashes = [hash(), hash()];
    const results = await Promise.all(
      codeHashes.map((codeHash) =>
        store.completePendingAuthorization(
          fresh.idHash,
          now,
          codeFor(codeHash),
        ),
      ),
    );

    assert.equal(results.filter(Boolean).length, 1);
    const stored = await Promise.all(
      codeHashes.map((codeHash) => store.findAuthorizationCode(codeHash)),
    );
    assert.equal(stored.filter(Boolean).length, 1);
    assert.equal(await store.findPendingAuthorization(fresh.idHash, now), null);
    assert.equal(
      await store.completePendingAuthorization(
        stale.idHash,
        at(11 * MINUTE),
        null,
      ),
      null,
    );
    assert.equal(
      await store.findPendingAuthorization(stale.idHash, at(11 * MINUTE)),
      null,
    );
  });

  it("redeems a code once under concurrency and shows replays the winner's grant", async () => {
    const codeHash = await saveCode();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => redeem(codeHash).result),
    );

    const winners = results.filter((result) => result.status === "ok");
    assert.equal(winners.length, 1);
    const winner = winners[0];
    const grantId = winner?.status === "ok" ? winner.grant.id : undefined;
    assert.ok(grantId);
    assert.deepEqual(
      results.filter((result) => result.status === "reused"),
      Array.from({ length: 4 }, () => ({ status: "reused", grantId })),
    );
  });

  it("rejects expired and unknown codes", async () => {
    const expired = await saveCode();

    assert.deepEqual(
      await redeem(expired, { createdAt: at(2 * MINUTE) }).result,
      { status: "invalid" },
    );
    assert.deepEqual(await redeem(hash()).result, { status: "invalid" });
  });

  it("keeps the code unused when the grant cap is reached", async () => {
    const kakaoUserId = `user-${crypto.randomUUID()}`;
    await createGrant({ kakaoUserId }, 1);
    const codeHash = await saveCode({ kakaoUserId });

    assert.deepEqual(await redeem(codeHash, {}, 1).result, {
      status: "limit",
    });
    assert.equal((await redeem(codeHash, {}, 2).result).status, "ok");
  });

  it("enforces the active grant cap under concurrency", async () => {
    const kakaoUserId = `user-${crypto.randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => createGrant({ kakaoUserId }, 3)),
    );

    assert.equal(results.filter((result) => result.grant).length, 3);
    assert.equal(await store.countActiveGrants(kakaoUserId, now), 3);
  });

  it("keeps redeemed codes of live grants when purging expired codes", async () => {
    const kakaoUserId = `user-${crypto.randomUUID()}`;
    const { grant, codeHash } = await createGrant({ kakaoUserId });
    const unused = await saveCode({ kakaoUserId });

    await saveCode({ kakaoUserId, createdAt: at(2 * MINUTE) });

    assert.deepEqual(
      await redeem(codeHash, { createdAt: at(2 * MINUTE) }).result,
      {
        status: "reused",
        grantId: grant?.id,
      },
    );
    assert.equal(await store.findAuthorizationCode(unused), null);
  });

  it("purges redeemed codes once their grant is revoked", async () => {
    const kakaoUserId = `user-${crypto.randomUUID()}`;
    const { grant, codeHash } = await createGrant({ kakaoUserId });
    await store.revokeGrant(grant?.id as string, now);

    await saveCode({ kakaoUserId, createdAt: at(2 * MINUTE) });

    assert.equal(await store.findAuthorizationCode(codeHash), null);
  });

  it("finds tokens with their grant", async () => {
    const { grant, access } = await createGrant();

    const found = await store.findToken(access.tokenHash);

    assert.equal(found?.token.kind, "access");
    assert.equal(found?.token.grantId, grant?.id);
    assert.equal(found?.grant.clientName, "Claude");
    assert.equal(await store.findToken(hash()), null);
  });

  it("rotates a refresh token once, even under concurrency", async () => {
    const { grant, refresh } = await createGrant();
    const later = at(5 * MINUTE);

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        store.rotateRefreshToken(
          refresh.tokenHash,
          [token("access"), token("refresh")],
          at(60 * 24 * 60 * MINUTE),
          later,
        ),
      ),
    );

    assert.equal(results.filter((result) => result.status === "ok").length, 1);
    assert.deepEqual(
      results.filter((result) => result.status === "reused"),
      [
        { status: "reused", grantId: grant?.id },
        { status: "reused", grantId: grant?.id },
      ],
    );
    const rotated = results.find((result) => result.status === "ok");
    assert.equal(
      rotated?.status === "ok" ? rotated.record.expiresAt : null,
      at(60 * 24 * 60 * MINUTE).toISOString(),
    );
  });

  it("does not rotate refresh tokens of revoked grants or expired tokens", async () => {
    const revoked = await createGrant();
    await store.revokeGrant(revoked.grant?.id as string, now);
    const expired = await createGrant();

    assert.deepEqual(
      await store.rotateRefreshToken(revoked.refresh.tokenHash, [], now, now),
      { status: "invalid" },
    );
    assert.deepEqual(
      await store.rotateRefreshToken(
        expired.refresh.tokenHash,
        [],
        now,
        at(31 * 24 * 60 * MINUTE),
      ),
      { status: "invalid" },
    );
  });

  it("revokes grants only for their owner when an owner is given", async () => {
    const { grant } = await createGrant({ kakaoUserId: "owner" });
    const id = grant?.id as string;

    assert.equal(await store.revokeGrant(id, now, "someone-else"), false);
    assert.equal(await store.revokeGrant(id, now, "owner"), true);
    assert.equal(await store.revokeGrant(id, now, "owner"), false);
    assert.deepEqual(await store.listGrantsForUser("owner", now), []);
  });

  it("lists an older active grant before newer expired ones", async () => {
    const kakaoUserId = `user-${crypto.randomUUID()}`;
    const { grant: active } = await createGrant({ kakaoUserId });
    for (let index = 1; index <= OAUTH_GRANT_LIST_LIMIT; index += 1) {
      const createdAt = at(index * 1000);
      await createGrant({ kakaoUserId, createdAt, expiresAt: createdAt });
    }
    const later = at(OAUTH_GRANT_LIST_LIMIT * 1000 + 1000);

    const listed = await store.listGrantsForUser(kakaoUserId, later);

    assert.equal(listed.length, OAUTH_GRANT_LIST_LIMIT);
    assert.equal(listed[0]?.id, active?.id);
  });

  it("throttles last-used updates", async () => {
    const kakaoUserId = `user-${crypto.randomUUID()}`;
    const { grant } = await createGrant({ kakaoUserId });

    await store.markGrantUsed(grant?.id as string, now, MINUTE);
    await store.markGrantUsed(grant?.id as string, at(1000), MINUTE);

    const [listed] = await store.listGrantsForUser(kakaoUserId, now);
    assert.equal(listed?.lastUsedAt, now.toISOString());
  });
  it("rejects authorization codes issued before account deletion", async () => {
    const codeHash = await saveCode({ kakaoUserId: "deleted-user" });
    await pool.query(
      "INSERT INTO account_deletion_guards(kakao_user_id,deleted_at) VALUES($1,$2)",
      ["deleted-user", at(1000)],
    );
    const result = await redeem(codeHash, { createdAt: at(2000) }).result;
    assert.equal(result.status, "invalid");
  });
});
