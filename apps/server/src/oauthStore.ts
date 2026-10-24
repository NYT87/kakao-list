import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Pool, PoolClient } from "pg";

// Persistence for the OAuth authorization server that lets MCP clients sign
// in with Kakao (docs/agent-access.md, phase 2). Everything lives in Postgres
// because the server runs as stateless serverless functions.
//
// A "grant" is one connected assistant: it is created when an authorization
// code is exchanged and owns that connection's access and refresh tokens, so
// revoking the grant disconnects the assistant. Codes, pending authorizations
// and tokens are stored by SHA-256 hash only.

export const OAUTH_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_pending_authorizations (
    id_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    state TEXT,
    scopes TEXT[] NOT NULL,
    resource TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  );

  CREATE INDEX IF NOT EXISTS oauth_pending_authorizations_expires_idx
    ON oauth_pending_authorizations (expires_at);

  CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    kakao_user_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes TEXT[] NOT NULL,
    resource TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    grant_id UUID
  );

  CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expires_idx
    ON oauth_authorization_codes (expires_at);

  CREATE TABLE IF NOT EXISTS oauth_grants (
    id UUID PRIMARY KEY,
    kakao_user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    scopes TEXT[] NOT NULL,
    resource TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS oauth_grants_user_created_idx
    ON oauth_grants (kakao_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id UUID NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    scopes TEXT[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens (grant_id);
`;

// Larger than the per-user cap on active grants, so every active one is listed.
export const OAUTH_GRANT_LIST_LIMIT = 100;

export interface PendingAuthorization {
  idHash: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scopes: string[];
  resource: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface NewAuthorizationCode {
  codeHash: string;
  clientId: string;
  clientName: string;
  kakaoUserId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface AuthorizationCodeRecord
  extends Omit<NewAuthorizationCode, "createdAt" | "expiresAt"> {
  expiresAt: string;
  usedAt: string | null;
  grantId: string | null;
}

export interface NewOAuthGrant {
  id: string;
  kakaoUserId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  resource: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface OAuthGrantRecord {
  id: string;
  kakaoUserId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  resource: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface NewOAuthToken {
  tokenHash: string;
  kind: "access" | "refresh";
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
}

export interface OAuthTokenRecord {
  tokenHash: string;
  grantId: string;
  kind: "access" | "refresh";
  scopes: string[];
  expiresAt: string;
  usedAt: string | null;
}

/** Outcome of consuming a single-use credential (authorization code, refresh token). */
export type ConsumeResult<T> =
  | { status: "ok"; record: T }
  /** Already used once: a replay. The caller revokes `grantId` when known. */
  | { status: "reused"; grantId: string | null }
  /** Unknown, expired, or belonging to a revoked grant. */
  | { status: "invalid" };

export type RedeemResult =
  | { status: "ok"; grant: OAuthGrantRecord }
  | { status: "reused"; grantId: string | null }
  | { status: "invalid" }
  | { status: "limit" };

export interface OAuthStore {
  saveClient(client: OAuthClientInformationFull, now: Date): Promise<void>;
  getClient(clientId: string): Promise<OAuthClientInformationFull | null>;

  /** Also purges expired pending authorizations. */
  savePendingAuthorization(pending: PendingAuthorization): Promise<void>;
  /** Deletes and returns the pending authorization if it exists and has not expired. */
  consumePendingAuthorization(
    idHash: string,
    now: Date,
  ): Promise<PendingAuthorization | null>;

  /** Also purges expired codes. */
  saveAuthorizationCode(code: NewAuthorizationCode): Promise<void>;
  findAuthorizationCode(
    codeHash: string,
  ): Promise<AuthorizationCodeRecord | null>;
  /**
   * Atomically marks the code used, creates the grant that `issue` describes
   * with its first tokens, and links the code to it. A concurrent or later
   * redemption of the same code reports `reused` with that grant's id, so the
   * caller can revoke it. When the user already has `maxActive` active
   * grants, nothing changes and the code stays unused.
   */
  redeemAuthorizationCode(
    codeHash: string,
    now: Date,
    issue: (code: AuthorizationCodeRecord) => {
      grant: NewOAuthGrant;
      tokens: NewOAuthToken[];
    },
    maxActive: number,
  ): Promise<RedeemResult>;

  countActiveGrants(kakaoUserId: string, now: Date): Promise<number>;

  /** Raw lookup; callers check kind, expiry and revocation. */
  findToken(
    tokenHash: string,
  ): Promise<{ token: OAuthTokenRecord; grant: OAuthGrantRecord } | null>;
  /**
   * Marks the refresh token used and stores its replacements atomically.
   * The grant's expiry moves to `grantExpiresAt`.
   */
  rotateRefreshToken(
    refreshTokenHash: string,
    replacements: NewOAuthToken[],
    grantExpiresAt: Date,
    now: Date,
  ): Promise<ConsumeResult<OAuthGrantRecord>>;

  /** With `kakaoUserId`, only revokes a grant owned by that user. */
  revokeGrant(
    grantId: string,
    now: Date,
    kakaoUserId?: string,
  ): Promise<boolean>;
  markGrantUsed(
    grantId: string,
    now: Date,
    resolutionMs: number,
  ): Promise<void>;
  /**
   * Non-revoked grants: active ones first, then the most recent expired ones,
   * newest first within each group, up to OAUTH_GRANT_LIST_LIMIT.
   */
  listGrantsForUser(
    kakaoUserId: string,
    now: Date,
  ): Promise<OAuthGrantRecord[]>;
}

interface GrantRow {
  id: string;
  kakao_user_id: string;
  client_id: string;
  client_name: string;
  scopes: string[];
  resource: string;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  client_name: string;
  kakao_user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  resource: string;
  expires_at: Date;
  used_at: Date | null;
  grant_id: string | null;
}

interface PendingRow {
  id_hash: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scopes: string[];
  resource: string;
  created_at: Date;
  expires_at: Date;
}

const GRANT_COLUMNS = `
  id, kakao_user_id, client_id, client_name, scopes, resource,
  created_at, expires_at, last_used_at, revoked_at
`;
const CODE_COLUMNS = `
  code_hash, client_id, client_name, kakao_user_id, redirect_uri,
  code_challenge, scopes, resource, expires_at, used_at, grant_id
`;

export function createPostgresOAuthStore(pool: Pool): OAuthStore {
  async function inTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertTokens(
    client: PoolClient,
    grantId: string,
    tokens: NewOAuthToken[],
  ) {
    for (const token of tokens) {
      await client.query(
        `
          INSERT INTO oauth_tokens
            (token_hash, grant_id, kind, scopes, created_at, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          token.tokenHash,
          grantId,
          token.kind,
          token.scopes,
          token.createdAt,
          token.expiresAt,
        ],
      );
    }
  }

  return {
    async saveClient(client, now) {
      await pool.query(
        `
          INSERT INTO oauth_clients (client_id, client_json, created_at)
          VALUES ($1, $2::jsonb, $3)
        `,
        [client.client_id, JSON.stringify(client), now],
      );
    },

    async getClient(clientId) {
      const result = await pool.query<{
        client_json: OAuthClientInformationFull;
      }>("SELECT client_json FROM oauth_clients WHERE client_id = $1", [
        clientId,
      ]);
      return result.rows[0]?.client_json ?? null;
    },

    async savePendingAuthorization(pending) {
      await pool.query(
        "DELETE FROM oauth_pending_authorizations WHERE expires_at <= $1",
        [pending.createdAt],
      );
      await pool.query(
        `
          INSERT INTO oauth_pending_authorizations
            (id_hash, client_id, client_name, redirect_uri, code_challenge,
             state, scopes, resource, created_at, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          pending.idHash,
          pending.clientId,
          pending.clientName,
          pending.redirectUri,
          pending.codeChallenge,
          pending.state,
          pending.scopes,
          pending.resource,
          pending.createdAt,
          pending.expiresAt,
        ],
      );
    },

    async consumePendingAuthorization(idHash, now) {
      // DELETE ... RETURNING makes the attempt single-use under concurrency.
      const result = await pool.query<PendingRow>(
        `
          DELETE FROM oauth_pending_authorizations
          WHERE id_hash = $1
          RETURNING *
        `,
        [idHash],
      );
      const row = result.rows[0];
      if (!row || row.expires_at.getTime() <= now.getTime()) {
        return null;
      }

      return {
        idHash: row.id_hash,
        clientId: row.client_id,
        clientName: row.client_name,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        state: row.state,
        scopes: row.scopes,
        resource: row.resource,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    },

    async saveAuthorizationCode(code) {
      await pool.query(
        "DELETE FROM oauth_authorization_codes WHERE expires_at <= $1",
        [code.createdAt],
      );
      await pool.query(
        `
          INSERT INTO oauth_authorization_codes
            (code_hash, client_id, client_name, kakao_user_id, redirect_uri,
             code_challenge, scopes, resource, created_at, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          code.codeHash,
          code.clientId,
          code.clientName,
          code.kakaoUserId,
          code.redirectUri,
          code.codeChallenge,
          code.scopes,
          code.resource,
          code.createdAt,
          code.expiresAt,
        ],
      );
    },

    async findAuthorizationCode(codeHash) {
      const result = await pool.query<CodeRow>(
        `SELECT ${CODE_COLUMNS} FROM oauth_authorization_codes WHERE code_hash = $1`,
        [codeHash],
      );
      const row = result.rows[0];
      return row ? toCodeRecord(row) : null;
    },

    async redeemAuthorizationCode(codeHash, now, issue, maxActive) {
      return inTransaction(async (client): Promise<RedeemResult> => {
        // The row lock is held until commit, so a concurrent redemption
        // waits and then sees used_at together with the committed grant_id.
        const locked = await client.query<CodeRow>(
          `
            SELECT ${CODE_COLUMNS}
            FROM oauth_authorization_codes
            WHERE code_hash = $1
            FOR UPDATE
          `,
          [codeHash],
        );
        const row = locked.rows[0];
        if (!row) {
          return { status: "invalid" };
        }
        if (row.used_at) {
          return { status: "reused", grantId: row.grant_id };
        }
        if (row.expires_at.getTime() <= now.getTime()) {
          return { status: "invalid" };
        }

        const { grant, tokens } = issue(toCodeRecord(row));
        // Serialize per user so concurrent exchanges cannot pass the cap.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `oauth_grants:${grant.kakaoUserId}`,
        ]);
        const active = await client.query<{ count: string }>(
          `
            SELECT count(*) AS count FROM oauth_grants
            WHERE kakao_user_id = $1 AND revoked_at IS NULL AND expires_at > $2
          `,
          [grant.kakaoUserId, now],
        );
        if (Number(active.rows[0]?.count ?? 0) >= maxActive) {
          return { status: "limit" };
        }

        const inserted = await client.query<GrantRow>(
          `
            INSERT INTO oauth_grants
              (id, kakao_user_id, client_id, client_name, scopes, resource,
               created_at, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING ${GRANT_COLUMNS}
          `,
          [
            grant.id,
            grant.kakaoUserId,
            grant.clientId,
            grant.clientName,
            grant.scopes,
            grant.resource,
            grant.createdAt,
            grant.expiresAt,
          ],
        );
        await insertTokens(client, grant.id, tokens);
        await client.query(
          `
            UPDATE oauth_authorization_codes
            SET used_at = $2, grant_id = $3
            WHERE code_hash = $1
          `,
          [codeHash, now, grant.id],
        );
        return {
          status: "ok",
          grant: toGrantRecord(inserted.rows[0] as GrantRow),
        };
      });
    },

    async countActiveGrants(kakaoUserId, now) {
      const result = await pool.query<{ count: string }>(
        `
          SELECT count(*) AS count FROM oauth_grants
          WHERE kakao_user_id = $1 AND revoked_at IS NULL AND expires_at > $2
        `,
        [kakaoUserId, now],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async findToken(tokenHash) {
      const result = await pool.query<
        GrantRow & {
          token_hash: string;
          kind: "access" | "refresh";
          token_scopes: string[];
          token_expires_at: Date;
          token_used_at: Date | null;
        }
      >(
        `
          SELECT t.token_hash, t.kind, t.scopes AS token_scopes,
                 t.expires_at AS token_expires_at, t.used_at AS token_used_at,
                 g.id, g.kakao_user_id, g.client_id, g.client_name, g.scopes,
                 g.resource, g.created_at, g.expires_at, g.last_used_at,
                 g.revoked_at
          FROM oauth_tokens t
          JOIN oauth_grants g ON g.id = t.grant_id
          WHERE t.token_hash = $1
        `,
        [tokenHash],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }

      return {
        token: {
          tokenHash: row.token_hash,
          grantId: row.id,
          kind: row.kind,
          scopes: row.token_scopes,
          expiresAt: row.token_expires_at.toISOString(),
          usedAt: row.token_used_at?.toISOString() ?? null,
        },
        grant: toGrantRecord(row),
      };
    },

    async rotateRefreshToken(
      refreshTokenHash,
      replacements,
      grantExpiresAt,
      now,
    ) {
      return inTransaction(async (client) => {
        // FOR UPDATE: two concurrent refreshes with the same token serialize;
        // the second sees used_at and is treated as a replay.
        const locked = await client.query<{
          grant_id: string;
          expires_at: Date;
          used_at: Date | null;
          revoked_at: Date | null;
        }>(
          `
            SELECT t.grant_id, t.expires_at, t.used_at, g.revoked_at
            FROM oauth_tokens t
            JOIN oauth_grants g ON g.id = t.grant_id
            WHERE t.token_hash = $1 AND t.kind = 'refresh'
            FOR UPDATE OF t
          `,
          [refreshTokenHash],
        );
        const row = locked.rows[0];
        if (!row) {
          return { status: "invalid" } as const;
        }
        if (row.used_at) {
          return { status: "reused", grantId: row.grant_id } as const;
        }
        if (row.revoked_at || row.expires_at.getTime() <= now.getTime()) {
          return { status: "invalid" } as const;
        }

        await client.query(
          "UPDATE oauth_tokens SET used_at = $2 WHERE token_hash = $1",
          [refreshTokenHash, now],
        );
        await client.query(
          "DELETE FROM oauth_tokens WHERE grant_id = $1 AND expires_at <= $2",
          [row.grant_id, now],
        );
        await insertTokens(client, row.grant_id, replacements);
        const updated = await client.query<GrantRow>(
          `
            UPDATE oauth_grants SET expires_at = $2
            WHERE id = $1
            RETURNING ${GRANT_COLUMNS}
          `,
          [row.grant_id, grantExpiresAt],
        );
        return {
          status: "ok",
          record: toGrantRecord(updated.rows[0] as GrantRow),
        } as const;
      });
    },

    async revokeGrant(grantId, now, kakaoUserId) {
      const result = await pool.query(
        `
          UPDATE oauth_grants SET revoked_at = $2
          WHERE id = $1
            AND revoked_at IS NULL
            AND ($3::text IS NULL OR kakao_user_id = $3)
        `,
        [grantId, now, kakaoUserId ?? null],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async markGrantUsed(grantId, now, resolutionMs) {
      await pool.query(
        `
          UPDATE oauth_grants SET last_used_at = $2
          WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $3)
        `,
        [grantId, now, new Date(now.getTime() - resolutionMs)],
      );
    },

    async listGrantsForUser(kakaoUserId, now) {
      const result = await pool.query<GrantRow>(
        `
          SELECT ${GRANT_COLUMNS}
          FROM oauth_grants
          WHERE kakao_user_id = $1 AND revoked_at IS NULL
          ORDER BY (expires_at > $2) DESC, created_at DESC
          LIMIT $3
        `,
        [kakaoUserId, now, OAUTH_GRANT_LIST_LIMIT],
      );
      return result.rows.map(toGrantRecord);
    },
  };
}

function toGrantRecord(row: GrantRow): OAuthGrantRecord {
  return {
    id: row.id,
    kakaoUserId: row.kakao_user_id,
    clientId: row.client_id,
    clientName: row.client_name,
    scopes: row.scopes,
    resource: row.resource,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

function toCodeRecord(row: CodeRow): AuthorizationCodeRecord {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    clientName: row.client_name,
    kakaoUserId: row.kakao_user_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scopes: row.scopes,
    resource: row.resource,
    expiresAt: row.expires_at.toISOString(),
    usedAt: row.used_at?.toISOString() ?? null,
    grantId: row.grant_id,
  };
}
