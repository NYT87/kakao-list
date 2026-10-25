import crypto from "node:crypto";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Pool } from "pg";

// Personal access tokens that let an AI agent read a user's lists through
// /mcp. They are separate from the 7-day session token on purpose: they are
// stored (hashed) so they can be listed and revoked, and they only grant
// read access. See docs/agent-access.md.

export const AGENT_TOKEN_PREFIX = "kl_pat_";
export const AGENT_SCOPE_LISTS_READ = "lists:read";
export const AGENT_TOKEN_MAX_ACTIVE = 10;
// Larger than AGENT_TOKEN_MAX_ACTIVE, so every active token is always listed.
export const AGENT_TOKEN_LIST_LIMIT = 100;
export const AGENT_TOKEN_LIFETIMES_DAYS = [30, 90, 365] as const;
const AGENT_TOKEN_DEFAULT_LIFETIME_DAYS = 90;
const AGENT_TOKEN_NAME_MAX_LENGTH = 60;
const AGENT_TOKEN_PATTERN = /^kl_pat_[A-Za-z0-9_-]{43}$/;
// Avoid a write on every MCP request; minute-level precision is enough.
const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const AGENT_TOKENS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS account_deletion_guards(kakao_user_id TEXT PRIMARY KEY,deleted_at TIMESTAMPTZ NOT NULL);

  CREATE TABLE IF NOT EXISTS agent_tokens (
    id UUID PRIMARY KEY,
    kakao_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_hint TEXT NOT NULL,
    scopes TEXT[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS agent_tokens_user_created_idx
    ON agent_tokens (kakao_user_id, created_at DESC);
`;

export interface AgentTokenRecord {
  id: string;
  kakaoUserId: string;
  name: string;
  tokenHint: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface NewAgentTokenRecord {
  browserSessionHash?: string;
  id: string;
  kakaoUserId: string;
  name: string;
  tokenHash: string;
  tokenHint: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
}

export interface AgentTokenStore {
  /** Inserts the token unless the user already has `maxActive` usable tokens. */
  createIfBelowLimit(
    token: NewAgentTokenRecord,
    maxActive: number,
  ): Promise<AgentTokenRecord | null>;
  findUsableByHash(
    tokenHash: string,
    now: Date,
  ): Promise<AgentTokenRecord | null>;
  markUsed(id: string, now: Date, resolutionMs: number): Promise<void>;
  /**
   * Non-revoked tokens: all active ones first, then the most recent expired
   * ones, newest first within each group, up to AGENT_TOKEN_LIST_LIMIT.
   */
  listForUser(kakaoUserId: string, now: Date): Promise<AgentTokenRecord[]>;
  /** Returns false when the token does not exist, is not owned by the user, or is already revoked. */
  revoke(kakaoUserId: string, id: string, now: Date): Promise<boolean>;
}

export interface AgentTokenInput {
  name: string;
  expiresInDays: (typeof AGENT_TOKEN_LIFETIMES_DAYS)[number];
}

export class AgentTokenLimitError extends Error {
  constructor() {
    super(
      `You can have at most ${AGENT_TOKEN_MAX_ACTIVE} active agent tokens. Revoke one first.`,
    );
  }
}

export function generateAgentToken() {
  return `${AGENT_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

// Tokens carry 256 bits of randomness, so a fast hash is sufficient; a slow
// password hash would only add latency to every MCP request.
export function hashAgentToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function parseAgentTokenInput(body: unknown): AgentTokenInput | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const { name, expiresInDays } = body as Record<string, unknown>;
  if (typeof name !== "string") {
    return null;
  }

  const trimmedName = name.trim();
  if (
    !trimmedName ||
    trimmedName.length > AGENT_TOKEN_NAME_MAX_LENGTH ||
    /\p{Cc}/u.test(trimmedName)
  ) {
    return null;
  }

  if (expiresInDays === undefined) {
    return {
      name: trimmedName,
      expiresInDays: AGENT_TOKEN_DEFAULT_LIFETIME_DAYS,
    };
  }

  const lifetime = AGENT_TOKEN_LIFETIMES_DAYS.find(
    (days) => days === expiresInDays,
  );
  return lifetime ? { name: trimmedName, expiresInDays: lifetime } : null;
}

export async function issueAgentToken(
  store: AgentTokenStore,
  input: AgentTokenInput & { kakaoUserId: string; browserSessionHash?: string },
  now: () => Date = () => new Date(),
): Promise<{ token: string; record: AgentTokenRecord }> {
  const token = generateAgentToken();
  const createdAt = now();
  const record = await store.createIfBelowLimit(
    {
      id: crypto.randomUUID(),
      kakaoUserId: input.kakaoUserId,
      browserSessionHash: input.browserSessionHash,
      name: input.name,
      tokenHash: hashAgentToken(token),
      tokenHint: `${AGENT_TOKEN_PREFIX}…${token.slice(-4)}`,
      scopes: [AGENT_SCOPE_LISTS_READ],
      createdAt,
      expiresAt: new Date(createdAt.getTime() + input.expiresInDays * DAY_MS),
    },
    AGENT_TOKEN_MAX_ACTIVE,
  );

  if (!record) {
    throw new AgentTokenLimitError();
  }

  return { token, record };
}

export function createAgentTokenVerifier(
  store: AgentTokenStore,
  now: () => Date = () => new Date(),
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token): Promise<AuthInfo> {
      if (!AGENT_TOKEN_PATTERN.test(token)) {
        throw new InvalidTokenError("Invalid access token");
      }

      const currentTime = now();
      const record = await store.findUsableByHash(
        hashAgentToken(token),
        currentTime,
      );
      if (!record) {
        throw new InvalidTokenError("Invalid or expired access token");
      }

      await store.markUsed(record.id, currentTime, LAST_USED_RESOLUTION_MS);

      return {
        token,
        clientId: `agent-token:${record.id}`,
        scopes: record.scopes,
        expiresAt: Date.parse(record.expiresAt) / 1000,
        extra: {
          kakaoUserId: record.kakaoUserId,
          agentTokenId: record.id,
        },
      };
    },
  };
}

interface AgentTokenRow {
  id: string;
  kakao_user_id: string;
  name: string;
  token_hint: string;
  scopes: string[];
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const RECORD_COLUMNS = `
  id, kakao_user_id, name, token_hint, scopes,
  created_at, expires_at, last_used_at, revoked_at
`;

export function createPostgresAgentTokenStore(pool: Pool): AgentTokenStore {
  return {
    async createIfBelowLimit(token, maxActive) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialize issuance per user so concurrent requests cannot both
        // pass the limit check.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `agent_tokens:${token.kakaoUserId}`,
        ]);
        if (token.browserSessionHash) {
          const session = await client.query(
            "SELECT 1 FROM browser_sessions WHERE token_hash=$1 AND kakao_user_id=$2 AND expires_at>now()",
            [token.browserSessionHash, token.kakaoUserId],
          );
          if (!session.rowCount) {
            await client.query("ROLLBACK");
            return null;
          }
        }
        const deleted = await client.query(
          "SELECT 1 FROM account_deletion_guards WHERE kakao_user_id=$1 AND deleted_at>=$2",
          [token.kakaoUserId, token.createdAt],
        );
        if (deleted.rowCount) {
          await client.query("ROLLBACK");
          return null;
        }
        const active = await client.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM agent_tokens
            WHERE kakao_user_id = $1
              AND revoked_at IS NULL
              AND expires_at > $2
          `,
          [token.kakaoUserId, token.createdAt],
        );
        if (Number(active.rows[0]?.count ?? 0) >= maxActive) {
          await client.query("ROLLBACK");
          return null;
        }

        const inserted = await client.query<AgentTokenRow>(
          `
            INSERT INTO agent_tokens
              (id, kakao_user_id, name, token_hash, token_hint, scopes, created_at, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING ${RECORD_COLUMNS}
          `,
          [
            token.id,
            token.kakaoUserId,
            token.name,
            token.tokenHash,
            token.tokenHint,
            token.scopes,
            token.createdAt,
            token.expiresAt,
          ],
        );
        await client.query("COMMIT");
        return toRecord(inserted.rows[0] as AgentTokenRow);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async findUsableByHash(tokenHash, now) {
      const result = await pool.query<AgentTokenRow>(
        `
          SELECT ${RECORD_COLUMNS}
          FROM agent_tokens
          WHERE token_hash = $1
            AND revoked_at IS NULL
            AND expires_at > $2
        `,
        [tokenHash, now],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    async markUsed(id, now, resolutionMs) {
      await pool.query(
        `
          UPDATE agent_tokens
          SET last_used_at = $2
          WHERE id = $1
            AND (last_used_at IS NULL OR last_used_at < $3)
        `,
        [id, now, new Date(now.getTime() - resolutionMs)],
      );
    },

    async listForUser(kakaoUserId, now) {
      const result = await pool.query<AgentTokenRow>(
        `
          SELECT ${RECORD_COLUMNS}
          FROM agent_tokens
          WHERE kakao_user_id = $1
            AND revoked_at IS NULL
          ORDER BY (expires_at > $2) DESC, created_at DESC
          LIMIT $3
        `,
        [kakaoUserId, now, AGENT_TOKEN_LIST_LIMIT],
      );
      return result.rows.map(toRecord);
    },

    async revoke(kakaoUserId, id, now) {
      const result = await pool.query(
        `
          UPDATE agent_tokens
          SET revoked_at = $3
          WHERE id = $1
            AND kakao_user_id = $2
            AND revoked_at IS NULL
        `,
        [id, kakaoUserId, now],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

function toRecord(row: AgentTokenRow): AgentTokenRecord {
  return {
    id: row.id,
    kakaoUserId: row.kakao_user_id,
    name: row.name,
    tokenHint: row.token_hint,
    scopes: row.scopes,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}
