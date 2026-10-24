import assert from "node:assert/strict";
import crypto from "node:crypto";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { AGENT_TOKENS_SCHEMA_SQL } from "./agentTokens.js";
import { runMaintenance } from "./maintenance.js";
import { createPostgresOAuthStore, OAUTH_SCHEMA_SQL } from "./oauthStore.js";
import { RATE_LIMIT_SCHEMA_SQL } from "./rateLimitStore.js";

// Runs only when TEST_DATABASE_URL is set (see agentTokens.postgres.test.ts).
const databaseUrl = process.env.TEST_DATABASE_URL;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("maintenance job", { skip: !databaseUrl }, () => {
  const schema = `maintenance_test_${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date("2026-10-24T12:00:00.000Z");
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
  let pool: Pool;

  async function client(clientId: string, createdAt: Date) {
    await pool.query(
      "INSERT INTO oauth_clients (client_id, client_json, created_at) VALUES ($1, $2, $3)",
      [
        clientId,
        JSON.stringify({ client_id: clientId, redirect_uris: [] }),
        createdAt,
      ],
    );
  }

  async function grant(
    id: string,
    clientId: string,
    fields: { expiresAt: Date; revokedAt?: Date },
  ) {
    await pool.query(
      `
        INSERT INTO oauth_grants
          (id, kakao_user_id, client_id, client_name, scopes, resource,
           created_at, expires_at, revoked_at)
        VALUES ($1, 'user-1', $2, 'Claude', '{lists:read}', 'https://x/mcp', $3, $4, $5)
      `,
      [id, clientId, at(-60 * DAY), fields.expiresAt, fields.revokedAt ?? null],
    );
  }

  async function oauthToken(hash: string, grantId: string, expiresAt: Date) {
    await pool.query(
      `
        INSERT INTO oauth_tokens (token_hash, grant_id, kind, scopes, created_at, expires_at)
        VALUES ($1, $2, 'access', '{lists:read}', $3, $4)
      `,
      [hash, grantId, at(-2 * HOUR), expiresAt],
    );
  }

  async function code(
    hash: string,
    fields: { expiresAt: Date; grantId?: string; clientId?: string },
  ) {
    await pool.query(
      `
        INSERT INTO oauth_authorization_codes
          (code_hash, client_id, client_name, kakao_user_id, redirect_uri,
           code_challenge, scopes, resource, created_at, expires_at, used_at, grant_id)
        VALUES ($1, $6, 'Claude', 'user-1', 'http://localhost/cb', 'x',
                '{lists:read}', 'https://x/mcp', $2, $3, $4, $5)
      `,
      [
        hash,
        at(-DAY),
        fields.expiresAt,
        fields.grantId ? at(-DAY) : null,
        fields.grantId ?? null,
        fields.clientId ?? "c",
      ],
    );
  }

  async function pending(hash: string, clientId: string, expiresAt: Date) {
    await pool.query(
      `
        INSERT INTO oauth_pending_authorizations
          (id_hash, client_id, client_name, redirect_uri, code_challenge,
           scopes, resource, created_at, expires_at)
        VALUES ($1, $2, 'Claude', 'http://localhost/cb', 'x', '{lists:read}',
                'https://x/mcp', $3, $4)
      `,
      [hash, clientId, at(-HOUR), expiresAt],
    );
  }

  async function agentToken(
    name: string,
    fields: { expiresAt: Date; revokedAt?: Date },
  ) {
    await pool.query(
      `
        INSERT INTO agent_tokens
          (id, kakao_user_id, name, token_hash, token_hint, scopes,
           created_at, expires_at, revoked_at)
        VALUES ($1, 'user-1', $2, $3, 'kl_pat_…abcd', '{lists:read}', $4, $5, $6)
      `,
      [
        crypto.randomUUID(),
        name,
        crypto.randomBytes(32).toString("hex"),
        at(-400 * DAY),
        fields.expiresAt,
        fields.revokedAt ?? null,
      ],
    );
  }

  async function bucket(key: string, resetAt: Date) {
    await pool.query(
      `
        INSERT INTO rate_limit_buckets (bucket_key, window_start, reset_at, hits)
        VALUES ($1, $2, $3, 1)
      `,
      [key, new Date(resetAt.getTime() - 60_000), resetAt],
    );
  }

  async function remaining(table: string, column: string) {
    const result = await pool.query<{ value: string }>(
      `SELECT ${column} AS value FROM ${table} ORDER BY 1`,
    );
    return result.rows.map((row) => row.value);
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
    await pool.query(AGENT_TOKENS_SCHEMA_SQL);
    await pool.query(RATE_LIMIT_SCHEMA_SQL);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  it("deletes abandoned and stale data and keeps everything still in use", async () => {
    const live = "00000000-0000-4000-8000-000000000001";
    const recentlyRevoked = "00000000-0000-4000-8000-000000000002";
    const longRevoked = "00000000-0000-4000-8000-000000000003";
    const longExpired = "00000000-0000-4000-8000-000000000004";

    // Clients: abandoned registrations go after a day; clients with a grant
    // that is live or ended in the last 30 days stay.
    await client("abandoned", at(-2 * DAY));
    await client("just-registered", at(-HOUR));
    await client("signing-in", at(-2 * DAY));
    await pending("pending-live", "signing-in", at(5 * 60_000));
    await client("connected", at(-60 * DAY));
    await grant(live, "connected", { expiresAt: at(20 * DAY) });
    await client("recently-disconnected", at(-60 * DAY));
    await grant(recentlyRevoked, "recently-disconnected", {
      expiresAt: at(20 * DAY),
      revokedAt: at(-DAY),
    });
    await client("long-gone", at(-90 * DAY));
    await grant(longRevoked, "long-gone", {
      expiresAt: at(20 * DAY),
      revokedAt: at(-31 * DAY),
    });
    await grant(longExpired, "long-gone", { expiresAt: at(-31 * DAY) });

    // Tokens of live grants: expired ones go, valid ones stay.
    await oauthToken("token-valid", live, at(HOUR));
    await oauthToken("token-expired", live, at(-HOUR));
    await oauthToken("token-of-long-revoked", longRevoked, at(HOUR));

    // Codes: unused expired codes go; redeemed codes of live grants stay.
    await code("code-unused-expired", { expiresAt: at(-HOUR) });
    await code("code-redeemed-live", { expiresAt: at(-HOUR), grantId: live });
    await code("code-redeemed-revoked", {
      expiresAt: at(-HOUR),
      grantId: longRevoked,
    });
    await code("code-fresh", { expiresAt: at(30_000) });
    // Signed in, code not exchanged yet: the client must survive.
    await client("awaiting-exchange", at(-2 * DAY));
    await code("code-outstanding", {
      expiresAt: at(30_000),
      clientId: "awaiting-exchange",
    });

    await pending("pending-expired", "signing-in", at(-60_000));

    await agentToken("active", { expiresAt: at(30 * DAY) });
    await agentToken("recently-expired", { expiresAt: at(-DAY) });
    await agentToken("long-expired", { expiresAt: at(-31 * DAY) });
    await agentToken("long-revoked", {
      expiresAt: at(30 * DAY),
      revokedAt: at(-31 * DAY),
    });

    await bucket("mcp-ip:current", at(30_000));
    await bucket("mcp-ip:old", at(-30_000));

    const result = await runMaintenance(pool, now);

    assert.deepEqual(result, {
      rateLimitBuckets: 1,
      pendingAuthorizations: 1,
      oauthTokens: 1,
      oauthGrants: 2,
      authorizationCodes: 2,
      oauthClients: 2,
      agentTokens: 2,
    });
    assert.deepEqual(await remaining("oauth_clients", "client_id"), [
      "awaiting-exchange",
      "connected",
      "just-registered",
      "recently-disconnected",
      "signing-in",
    ]);
    assert.deepEqual(await remaining("oauth_grants", "id::text"), [
      live,
      recentlyRevoked,
    ]);
    assert.deepEqual(await remaining("oauth_tokens", "token_hash"), [
      "token-valid",
    ]);
    assert.deepEqual(
      await remaining("oauth_authorization_codes", "code_hash"),
      ["code-fresh", "code-outstanding", "code-redeemed-live"],
    );
    assert.deepEqual(
      await remaining("oauth_pending_authorizations", "id_hash"),
      ["pending-live"],
    );
    assert.deepEqual(await remaining("agent_tokens", "name"), [
      "active",
      "recently-expired",
    ]);
    assert.deepEqual(await remaining("rate_limit_buckets", "bucket_key"), [
      "mcp-ip:current",
    ]);
  });

  it("is a no-op on a second run", async () => {
    const result = await runMaintenance(pool, now);

    assert.ok(Object.values(result).every((count) => count === 0));
  });

  function pendingFor(clientId: string) {
    return {
      idHash: crypto.randomBytes(32).toString("hex"),
      clientId,
      clientName: "Claude",
      redirectUri: "http://localhost/cb",
      codeChallenge: "x",
      state: null,
      scopes: ["lists:read"],
      resource: "https://x/mcp",
      createdAt: now,
      expiresAt: at(5 * 60_000),
    };
  }

  async function clientExists(clientId: string) {
    const result = await pool.query(
      "SELECT 1 FROM oauth_clients WHERE client_id = $1",
      [clientId],
    );
    return result.rowCount === 1;
  }

  it("skips a client whose sign-in is starting", async () => {
    await client("starting", at(-2 * DAY));
    // What savePendingAuthorization holds while it saves: a share lock on
    // the client row, before its pending row is committed.
    const signIn = await pool.connect();
    try {
      await signIn.query("BEGIN");
      await signIn.query(
        "SELECT 1 FROM oauth_clients WHERE client_id = 'starting' FOR SHARE",
      );

      // Cleanup must skip the locked client, not wait for it.
      const finished = await Promise.race([
        runMaintenance(pool, now).then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      assert.equal(finished, true, "cleanup waited for the starting sign-in");
      assert.equal(await clientExists("starting"), true);
    } finally {
      await signIn.query("ROLLBACK");
      signIn.release();
    }
  });

  it("makes a sign-in fail when cleanup deletes its client first", async () => {
    await client("being-deleted", at(-2 * DAY));
    const store = createPostgresOAuthStore(pool);
    // What runMaintenance holds while deleting: an update lock on the row.
    const cleanup = await pool.connect();
    try {
      await cleanup.query("BEGIN");
      await cleanup.query(
        "SELECT 1 FROM oauth_clients WHERE client_id = 'being-deleted' FOR UPDATE",
      );
      const saving = store.savePendingAuthorization(
        pendingFor("being-deleted"),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await cleanup.query(
        "DELETE FROM oauth_clients WHERE client_id = 'being-deleted'",
      );
      await cleanup.query("COMMIT");

      assert.equal(await saving, false);
    } finally {
      cleanup.release();
    }
    const orphans = await pool.query(
      "SELECT 1 FROM oauth_pending_authorizations WHERE client_id = 'being-deleted'",
    );
    assert.equal(orphans.rowCount, 0);
  });

  it("never leaves a saved sign-in without its client", async () => {
    const store = createPostgresOAuthStore(pool);
    for (let round = 0; round < 20; round += 1) {
      const clientId = `race-${round}`;
      await client(clientId, at(-2 * DAY));

      const [saved] = await Promise.all([
        store.savePendingAuthorization(pendingFor(clientId)),
        runMaintenance(pool, now),
      ]);

      assert.equal(await clientExists(clientId), saved, clientId);
    }
  });
});
