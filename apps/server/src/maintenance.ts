import crypto from "node:crypto";
import express from "express";
import type { Pool } from "pg";

// Deletes data the agent-access features no longer need. Runs daily from
// Vercel Cron (GET /api/cron/maintenance with the CRON_SECRET bearer token)
// and hourly when the server runs as a normal process. Every statement is
// idempotent, so overlapping or repeated runs are harmless.

/** Revoked or expired grants and agent tokens stay listed this long. */
const ENDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Registrations that never completed a sign-in are dropped after this. */
const ABANDONED_CLIENT_MS = 24 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 16;

export interface MaintenanceResult {
  rateLimitBuckets: number;
  pendingAuthorizations: number;
  oauthTokens: number;
  oauthGrants: number;
  authorizationCodes: number;
  oauthClients: number;
  agentTokens: number;
}

export async function runMaintenance(
  pool: Pool,
  now: Date = new Date(),
): Promise<MaintenanceResult> {
  const endedBefore = new Date(now.getTime() - ENDED_RETENTION_MS);
  const abandonedBefore = new Date(now.getTime() - ABANDONED_CLIENT_MS);
  const count = async (sql: string, params: unknown[]) =>
    (await pool.query(sql, params)).rowCount ?? 0;

  // Order matters: grants go before codes and clients, so codes and clients
  // that only referenced those grants become deletable in the same run.
  const rateLimitBuckets = await count(
    "DELETE FROM rate_limit_buckets WHERE reset_at <= $1",
    [now],
  );
  const pendingAuthorizations = await count(
    "DELETE FROM oauth_pending_authorizations WHERE expires_at <= $1",
    [now],
  );
  // Expired tokens can no longer be used; a replayed expired refresh token
  // is rejected as unknown.
  const oauthTokens = await count(
    "DELETE FROM oauth_tokens WHERE expires_at <= $1",
    [now],
  );
  // Tokens of deleted grants go with them (ON DELETE CASCADE).
  const oauthGrants = await count(
    `
      DELETE FROM oauth_grants
      WHERE revoked_at <= $1
         OR (revoked_at IS NULL AND expires_at <= $1)
    `,
    [endedBefore],
  );
  // Redeemed codes of live grants are kept for replay detection.
  const authorizationCodes = await count(
    `
      DELETE FROM oauth_authorization_codes c
      WHERE c.expires_at <= $1
        AND NOT EXISTS (
          SELECT 1 FROM oauth_grants g
          WHERE g.id = c.grant_id
            AND g.revoked_at IS NULL
            AND g.expires_at > $1
        )
    `,
    [now],
  );
  const oauthClients = await deleteUnusedClients(pool, abandonedBefore, now);
  const agentTokens = await count(
    "DELETE FROM agent_tokens WHERE revoked_at <= $1 OR expires_at <= $1",
    [endedBefore],
  );

  return {
    rateLimitBuckets,
    pendingAuthorizations,
    oauthTokens,
    oauthGrants,
    authorizationCodes,
    oauthClients,
    agentTokens,
  };
}

/**
 * Deletes clients without grants and without a sign-in in flight:
 * never-completed registrations, and clients whose last grant ended over the
 * retention period ago. A sign-in in flight always has a pending
 * authorization or an unexpired code (the Kakao callback swaps one for the
 * other atomically), then a grant once the code is exchanged.
 *
 * Coordination with a sign-in that is just starting (the SDK has read the
 * client; its pending authorization is not saved yet): saving share-locks the
 * client row (oauthStore.ts). Here candidates are locked FOR UPDATE SKIP
 * LOCKED, so a client being signed into is skipped, and the conditions are
 * re-checked by a second statement, whose fresh snapshot sees any pending
 * authorization committed before the lock was taken. A sign-in starting after
 * the lock waits, finds the client deleted, and fails at /authorize.
 */
async function deleteUnusedClients(
  pool: Pool,
  abandonedBefore: Date,
  now: Date,
): Promise<number> {
  const unused = `
    c.created_at <= $1
    AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)
    AND NOT EXISTS (
      SELECT 1 FROM oauth_pending_authorizations p WHERE p.client_id = c.client_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM oauth_authorization_codes a
      WHERE a.client_id = c.client_id AND a.expires_at > $2
    )
  `;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ client_id: string }>(
      `SELECT c.client_id FROM oauth_clients c WHERE ${unused} FOR UPDATE OF c SKIP LOCKED`,
      [abandonedBefore, now],
    );
    const ids = locked.rows.map((row) => row.client_id);
    const deleted =
      ids.length === 0
        ? 0
        : ((
            await client.query(
              `DELETE FROM oauth_clients c WHERE c.client_id = ANY($3) AND ${unused}`,
              [abandonedBefore, now, ids],
            )
          ).rowCount ?? 0);
    await client.query("COMMIT");
    return deleted;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** GET endpoint for Vercel Cron, which sends `Authorization: Bearer <CRON_SECRET>`. */
export function createMaintenanceRouter(options: {
  secret: string;
  run: () => Promise<MaintenanceResult>;
}): express.Router {
  if (options.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `CRON_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }

  const expected = `Bearer ${options.secret}`;
  const router = express.Router();

  router.get("/", async (request, response) => {
    response.set("Cache-Control", "no-store");
    if (!matches(request.header("authorization") ?? "", expected)) {
      console.warn("[maintenance] rejected a request without the cron secret");
      response.status(401).send("Unauthorized.");
      return;
    }

    try {
      const deleted = await options.run();
      console.info(`[maintenance] deleted ${JSON.stringify(deleted)}`);
      response.json({ deleted });
    } catch (error) {
      console.error(
        `[maintenance] failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      response.status(500).send("Maintenance failed.");
    }
  });

  router.all("/", (_request, response) => {
    response.status(405).set("Allow", "GET").send("Method not allowed.");
  });

  return router;
}

function matches(actual: string, expected: string) {
  const digest = (value: string) =>
    crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(actual), digest(expected));
}
