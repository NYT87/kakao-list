import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  type AuthorizationCodeRecord,
  OAUTH_GRANT_LIST_LIMIT,
  type OAuthGrantRecord,
  type OAuthStore,
  type OAuthTokenRecord,
  type PendingAuthorization,
} from "../oauthStore.js";

// Test double with the same semantics as the Postgres store.
export function createInMemoryOAuthStore(): OAuthStore {
  const clients = new Map<string, OAuthClientInformationFull>();
  const pending = new Map<string, PendingAuthorization>();
  const codes = new Map<string, AuthorizationCodeRecord>();
  const grants = new Map<string, OAuthGrantRecord>();
  const tokens = new Map<string, OAuthTokenRecord>();
  const isActive = (grant: OAuthGrantRecord, now: Date) =>
    grant.revokedAt === null && Date.parse(grant.expiresAt) > now.getTime();
  const copyGrant = (grant: OAuthGrantRecord) => ({
    ...grant,
    scopes: [...grant.scopes],
  });

  return {
    async saveClient(client) {
      clients.set(client.client_id, structuredClone(client));
    },

    async getClient(clientId) {
      const client = clients.get(clientId);
      return client ? structuredClone(client) : null;
    },

    async savePendingAuthorization(authorization) {
      for (const [key, value] of pending) {
        if (value.expiresAt.getTime() <= authorization.createdAt.getTime()) {
          pending.delete(key);
        }
      }
      pending.set(authorization.idHash, { ...authorization });
    },

    async consumePendingAuthorization(idHash, now) {
      const found = pending.get(idHash);
      pending.delete(idHash);
      return found && found.expiresAt.getTime() > now.getTime()
        ? { ...found }
        : null;
    },

    async saveAuthorizationCode(code) {
      for (const [key, value] of codes) {
        if (Date.parse(value.expiresAt) <= code.createdAt.getTime()) {
          codes.delete(key);
        }
      }
      codes.set(code.codeHash, {
        codeHash: code.codeHash,
        clientId: code.clientId,
        clientName: code.clientName,
        kakaoUserId: code.kakaoUserId,
        redirectUri: code.redirectUri,
        codeChallenge: code.codeChallenge,
        scopes: [...code.scopes],
        resource: code.resource,
        expiresAt: code.expiresAt.toISOString(),
        usedAt: null,
        grantId: null,
      });
    },

    async findAuthorizationCode(codeHash) {
      const code = codes.get(codeHash);
      return code ? { ...code } : null;
    },

    // No await between the checks and the writes, so this is atomic.
    async redeemAuthorizationCode(codeHash, now, issue, maxActive) {
      const code = codes.get(codeHash);
      if (!code) {
        return { status: "invalid" };
      }
      if (code.usedAt) {
        return { status: "reused", grantId: code.grantId };
      }
      if (Date.parse(code.expiresAt) <= now.getTime()) {
        return { status: "invalid" };
      }

      const { grant, tokens: newTokens } = issue({ ...code });
      const active = [...grants.values()].filter(
        (existing) =>
          existing.kakaoUserId === grant.kakaoUserId && isActive(existing, now),
      );
      if (active.length >= maxActive) {
        return { status: "limit" };
      }

      const record: OAuthGrantRecord = {
        id: grant.id,
        kakaoUserId: grant.kakaoUserId,
        clientId: grant.clientId,
        clientName: grant.clientName,
        scopes: [...grant.scopes],
        resource: grant.resource,
        createdAt: grant.createdAt.toISOString(),
        expiresAt: grant.expiresAt.toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      };
      grants.set(record.id, record);
      for (const token of newTokens) {
        tokens.set(token.tokenHash, {
          tokenHash: token.tokenHash,
          grantId: record.id,
          kind: token.kind,
          scopes: [...token.scopes],
          expiresAt: token.expiresAt.toISOString(),
          usedAt: null,
        });
      }
      code.usedAt = now.toISOString();
      code.grantId = record.id;
      return { status: "ok", grant: copyGrant(record) };
    },

    async countActiveGrants(kakaoUserId, now) {
      return [...grants.values()].filter(
        (grant) => grant.kakaoUserId === kakaoUserId && isActive(grant, now),
      ).length;
    },

    async findToken(tokenHash) {
      const token = tokens.get(tokenHash);
      const grant = token ? grants.get(token.grantId) : undefined;
      return token && grant
        ? { token: { ...token }, grant: copyGrant(grant) }
        : null;
    },

    async rotateRefreshToken(
      refreshTokenHash,
      replacements,
      grantExpiresAt,
      now,
    ) {
      const token = tokens.get(refreshTokenHash);
      const grant = token ? grants.get(token.grantId) : undefined;
      if (token?.kind !== "refresh" || !grant) {
        return { status: "invalid" };
      }
      if (token.usedAt) {
        return { status: "reused", grantId: grant.id };
      }
      if (grant.revokedAt || Date.parse(token.expiresAt) <= now.getTime()) {
        return { status: "invalid" };
      }

      token.usedAt = now.toISOString();
      for (const [key, value] of tokens) {
        if (
          value.grantId === grant.id &&
          Date.parse(value.expiresAt) <= now.getTime()
        ) {
          tokens.delete(key);
        }
      }
      for (const replacement of replacements) {
        tokens.set(replacement.tokenHash, {
          tokenHash: replacement.tokenHash,
          grantId: grant.id,
          kind: replacement.kind,
          scopes: [...replacement.scopes],
          expiresAt: replacement.expiresAt.toISOString(),
          usedAt: null,
        });
      }
      grant.expiresAt = grantExpiresAt.toISOString();
      return { status: "ok", record: copyGrant(grant) };
    },

    async revokeGrant(grantId, now, kakaoUserId) {
      const grant = grants.get(grantId);
      if (
        !grant ||
        grant.revokedAt !== null ||
        (kakaoUserId !== undefined && grant.kakaoUserId !== kakaoUserId)
      ) {
        return false;
      }
      grant.revokedAt = now.toISOString();
      return true;
    },

    async markGrantUsed(grantId, now, resolutionMs) {
      const grant = grants.get(grantId);
      if (
        grant &&
        (grant.lastUsedAt === null ||
          Date.parse(grant.lastUsedAt) < now.getTime() - resolutionMs)
      ) {
        grant.lastUsedAt = now.toISOString();
      }
    },

    async listGrantsForUser(kakaoUserId, now) {
      return [...grants.values()]
        .filter(
          (grant) =>
            grant.kakaoUserId === kakaoUserId && grant.revokedAt === null,
        )
        .sort(
          (left, right) =>
            Number(isActive(right, now)) - Number(isActive(left, now)) ||
            right.createdAt.localeCompare(left.createdAt),
        )
        .slice(0, OAUTH_GRANT_LIST_LIMIT)
        .map(copyGrant);
    },
  };
}
