import crypto from "node:crypto";
import type { CloudSession, KakaoUserProfile } from "@kakao-lists/domain";
import type { Pool } from "pg";

export function validateSecurityConfiguration(env: NodeJS.ProcessEnv) {
  const secret = env.SYNC_SERVER_SIGNING_SECRET;
  if (
    !secret ||
    secret.length < 32 ||
    new Set(secret).size < 8 ||
    /change-me|replace_with|your[_-].*secret/i.test(secret)
  )
    throw new Error(
      "Set SYNC_SERVER_SIGNING_SECRET to a random secret of at least 32 characters.",
    );
  const production = env.NODE_ENV === "production" || Boolean(env.VERCEL);
  if (production && env.ALLOW_MOCK_AUTH === "true")
    throw new Error("Mock authentication is forbidden in production.");
  return secret;
}

export const SESSION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS browser_sessions (
    token_hash TEXT PRIMARY KEY,
    kakao_user_id TEXT NOT NULL,
    profile_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS browser_sessions_user_idx ON browser_sessions(kakao_user_id);
`;

export function sessionStore(pool: Pool, now = () => new Date()) {
  const hash = (token: string) =>
    crypto.createHash("sha256").update(token).digest("hex");
  return {
    async issue(
      user: KakaoUserProfile,
      startedAt = now(),
    ): Promise<CloudSession> {
      const token = `kl_session_${crypto.randomBytes(32).toString("base64url")}`;
      const issuedAt = now();
      const expiresAt = new Date(
        issuedAt.getTime() + 7 * 86400000,
      ).toISOString();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `account:${user.id}`,
        ]);
        const deleted = await client.query(
          "SELECT 1 FROM account_deletion_guards WHERE kakao_user_id=$1 AND deleted_at>=$2",
          [user.id, startedAt],
        );
        if (deleted.rowCount)
          throw new Error(
            "Sign-in was cancelled by account deletion. Start again.",
          );
        await client.query(
          "INSERT INTO browser_sessions(token_hash,kakao_user_id,profile_json,created_at,expires_at) VALUES($1,$2,$3::jsonb,$4,$5)",
          [hash(token), user.id, JSON.stringify(user), issuedAt, expiresAt],
        );
        await client.query(
          "DELETE FROM browser_sessions WHERE kakao_user_id=$1 AND token_hash NOT IN (SELECT token_hash FROM browser_sessions WHERE kakao_user_id=$1 ORDER BY created_at DESC,token_hash LIMIT 20)",
          [user.id],
        );
        await client.query("COMMIT");
        return { token, expiresAt, user };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async find(token: string): Promise<CloudSession | null> {
      if (!/^kl_session_[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const result = await pool.query<{
        profile_json: KakaoUserProfile;
        expires_at: Date;
      }>(
        "SELECT profile_json,expires_at FROM browser_sessions WHERE token_hash=$1 AND expires_at>$2",
        [hash(token), now()],
      );
      const row = result.rows[0];
      return row
        ? {
            token,
            user: row.profile_json,
            expiresAt: new Date(row.expires_at).toISOString(),
          }
        : null;
    },
    async revoke(token: string) {
      await pool.query("DELETE FROM browser_sessions WHERE token_hash=$1", [
        hash(token),
      ]);
    },
    async revokeAll(userId: string) {
      await pool.query("DELETE FROM browser_sessions WHERE kakao_user_id=$1", [
        userId,
      ]);
    },
  };
}

/** Authenticated encryption with key separation from the legacy signing use. */
export function credentialVault(secret: string) {
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      secret,
      "kakao-lists",
      "kakao-credential-encryption-v1",
      32,
    ),
  );
  return {
    encrypt(value: string): string {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
    },
    decrypt(value: string): string {
      if (!value.startsWith("enc:v1:"))
        throw new Error("Legacy credentials require signing in again.");
      const [, , iv, tag, ciphertext] = value.split(":");
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
