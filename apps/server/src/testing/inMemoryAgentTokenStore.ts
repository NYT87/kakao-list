import {
  AGENT_TOKEN_LIST_LIMIT,
  type AgentTokenRecord,
  type AgentTokenStore,
  type NewAgentTokenRecord,
} from "../agentTokens.js";

type StoredToken = AgentTokenRecord & { tokenHash: string };

// Test double with the same semantics as the Postgres store.
export function createInMemoryAgentTokenStore(): AgentTokenStore & {
  dump(): StoredToken[];
} {
  const tokens: StoredToken[] = [];
  const isUsable = (token: StoredToken, now: Date) =>
    token.revokedAt === null && Date.parse(token.expiresAt) > now.getTime();

  return {
    async createIfBelowLimit(token: NewAgentTokenRecord, maxActive: number) {
      const active = tokens.filter(
        (stored) =>
          stored.kakaoUserId === token.kakaoUserId &&
          isUsable(stored, token.createdAt),
      );
      if (active.length >= maxActive) {
        return null;
      }

      const stored: StoredToken = {
        id: token.id,
        kakaoUserId: token.kakaoUserId,
        name: token.name,
        tokenHash: token.tokenHash,
        tokenHint: token.tokenHint,
        scopes: [...token.scopes],
        createdAt: token.createdAt.toISOString(),
        expiresAt: token.expiresAt.toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      };
      tokens.push(stored);
      return toRecord(stored);
    },

    async findUsableByHash(tokenHash, now) {
      const stored = tokens.find(
        (token) => token.tokenHash === tokenHash && isUsable(token, now),
      );
      return stored ? toRecord(stored) : null;
    },

    async markUsed(id, now, resolutionMs) {
      const stored = tokens.find((token) => token.id === id);
      if (
        stored &&
        (stored.lastUsedAt === null ||
          Date.parse(stored.lastUsedAt) < now.getTime() - resolutionMs)
      ) {
        stored.lastUsedAt = now.toISOString();
      }
    },

    async listForUser(kakaoUserId, now) {
      return tokens
        .filter(
          (token) =>
            token.kakaoUserId === kakaoUserId && token.revokedAt === null,
        )
        .sort(
          (left, right) =>
            Number(isUsable(right, now)) - Number(isUsable(left, now)) ||
            right.createdAt.localeCompare(left.createdAt),
        )
        .slice(0, AGENT_TOKEN_LIST_LIMIT)
        .map(toRecord);
    },

    async revoke(kakaoUserId, id, now) {
      const stored = tokens.find(
        (token) =>
          token.id === id &&
          token.kakaoUserId === kakaoUserId &&
          token.revokedAt === null,
      );
      if (!stored) {
        return false;
      }

      stored.revokedAt = now.toISOString();
      return true;
    },

    dump() {
      return tokens.map((token) => ({ ...token }));
    },
  };
}

function toRecord({ tokenHash: _tokenHash, ...record }: StoredToken) {
  return { ...record, scopes: [...record.scopes] };
}
