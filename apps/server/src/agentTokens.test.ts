import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  AGENT_TOKEN_LIST_LIMIT,
  AGENT_TOKEN_MAX_ACTIVE,
  AGENT_TOKEN_PREFIX,
  AgentTokenLimitError,
  createAgentTokenVerifier,
  generateAgentToken,
  hashAgentToken,
  issueAgentToken,
  parseAgentTokenInput,
} from "./agentTokens.js";
import { createInMemoryAgentTokenStore } from "./testing/inMemoryAgentTokenStore.js";

const now = new Date("2026-10-24T00:00:00.000Z");
const clock = () => now;

describe("generateAgentToken", () => {
  it("creates a prefixed, high-entropy, url-safe token", () => {
    const token = generateAgentToken();

    assert.match(token, /^kl_pat_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(generateAgentToken(), token);
  });
});

describe("hashAgentToken", () => {
  it("is deterministic and never returns the token itself", () => {
    const token = generateAgentToken();

    assert.equal(hashAgentToken(token), hashAgentToken(token));
    assert.notEqual(hashAgentToken(token), token);
    assert.match(hashAgentToken(token), /^[0-9a-f]{64}$/);
  });
});

describe("parseAgentTokenInput", () => {
  it("accepts a trimmed name and a supported lifetime", () => {
    assert.deepEqual(
      parseAgentTokenInput({ name: "  Claude Desktop ", expiresInDays: 30 }),
      { name: "Claude Desktop", expiresInDays: 30 },
    );
  });

  it("defaults the lifetime to 90 days", () => {
    assert.deepEqual(parseAgentTokenInput({ name: "Cursor" }), {
      name: "Cursor",
      expiresInDays: 90,
    });
  });

  const invalid: Array<[string, unknown]> = [
    ["a missing body", undefined],
    ["a missing name", {}],
    ["a blank name", { name: "   " }],
    ["a name longer than 60 characters", { name: "x".repeat(61) }],
    ["a name with control characters", { name: "bad\nname" }],
    ["an unsupported lifetime", { name: "ok", expiresInDays: 7 }],
    ["a non-numeric lifetime", { name: "ok", expiresInDays: "30" }],
  ];

  for (const [label, body] of invalid) {
    it(`rejects ${label}`, () => {
      assert.equal(parseAgentTokenInput(body), null);
    });
  }
});

describe("issueAgentToken", () => {
  it("stores only the hash and returns the token once", async () => {
    const store = createInMemoryAgentTokenStore();

    const { token, record } = await issueAgentToken(
      store,
      { kakaoUserId: "user-1", name: "Claude", expiresInDays: 30 },
      clock,
    );

    assert.ok(token.startsWith(AGENT_TOKEN_PREFIX));
    assert.equal(record.kakaoUserId, "user-1");
    assert.deepEqual(record.scopes, ["lists:read"]);
    assert.equal(record.expiresAt, "2026-11-23T00:00:00.000Z");
    assert.equal(record.tokenHint, `${AGENT_TOKEN_PREFIX}…${token.slice(-4)}`);
    assert.equal(JSON.stringify(store.dump()).includes(token), false);
  });

  it("refuses to exceed the active token limit per user", async () => {
    const store = createInMemoryAgentTokenStore();
    const input = {
      kakaoUserId: "user-1",
      name: "Agent",
      expiresInDays: 30 as const,
    };
    for (let index = 0; index < AGENT_TOKEN_MAX_ACTIVE; index += 1) {
      await issueAgentToken(store, input, clock);
    }

    await assert.rejects(
      issueAgentToken(store, input, clock),
      AgentTokenLimitError,
    );
    await issueAgentToken(store, { ...input, kakaoUserId: "user-2" }, clock);
  });
});

describe("in-memory store listing", () => {
  it("lists active tokens before newer expired ones, within the list limit", async () => {
    const store = createInMemoryAgentTokenStore();
    const active = await issueAgentToken(
      store,
      { kakaoUserId: "user-1", name: "Long-lived", expiresInDays: 365 },
      clock,
    );
    for (let index = 1; index <= AGENT_TOKEN_LIST_LIMIT; index += 1) {
      const createdAt = new Date(now.getTime() + index * 1000);
      await store.createIfBelowLimit(
        {
          id: `expired-${index}`,
          kakaoUserId: "user-1",
          name: "Short-lived",
          tokenHash: `hash-${index}`,
          tokenHint: "kl_pat_…0000",
          scopes: ["lists:read"],
          createdAt,
          expiresAt: createdAt,
        },
        AGENT_TOKEN_MAX_ACTIVE,
      );
    }
    const later = new Date(now.getTime() + 1000 * 1000);

    const listed = await store.listForUser("user-1", later);

    assert.equal(listed.length, AGENT_TOKEN_LIST_LIMIT);
    assert.equal(listed[0]?.id, active.record.id);
    assert.equal(listed[1]?.id, `expired-${AGENT_TOKEN_LIST_LIMIT}`);
  });
});

describe("createAgentTokenVerifier", () => {
  it("returns auth info bound to the token owner", async () => {
    const store = createInMemoryAgentTokenStore();
    const { token, record } = await issueAgentToken(
      store,
      { kakaoUserId: "user-1", name: "Claude", expiresInDays: 30 },
      clock,
    );

    const authInfo = await createAgentTokenVerifier(
      store,
      clock,
    ).verifyAccessToken(token);

    assert.equal(authInfo.clientId, `agent-token:${record.id}`);
    assert.deepEqual(authInfo.scopes, ["lists:read"]);
    assert.equal(authInfo.expiresAt, Date.parse(record.expiresAt) / 1000);
    assert.deepEqual(authInfo.extra, {
      kakaoUserId: "user-1",
      agentTokenId: record.id,
    });
  });

  it("records when the token was last used", async () => {
    const store = createInMemoryAgentTokenStore();
    const { token, record } = await issueAgentToken(
      store,
      { kakaoUserId: "user-1", name: "Claude", expiresInDays: 30 },
      clock,
    );

    await createAgentTokenVerifier(store, clock).verifyAccessToken(token);

    const [listed] = await store.listForUser("user-1", now);
    assert.equal(listed?.id, record.id);
    assert.equal(listed?.lastUsedAt, now.toISOString());
  });

  it("rejects malformed, unknown, revoked and expired tokens", async () => {
    const store = createInMemoryAgentTokenStore();
    const issue = () =>
      issueAgentToken(
        store,
        { kakaoUserId: "user-1", name: "Claude", expiresInDays: 30 },
        clock,
      );
    const revoked = await issue();
    await store.revoke("user-1", revoked.record.id, now);
    const expiring = await issue();
    const later = () => new Date(Date.parse(expiring.record.expiresAt) + 1);

    const verifier = createAgentTokenVerifier(store, clock);
    await assert.rejects(
      verifier.verifyAccessToken("not-a-token"),
      InvalidTokenError,
    );
    await assert.rejects(
      verifier.verifyAccessToken(generateAgentToken()),
      InvalidTokenError,
    );
    await assert.rejects(
      verifier.verifyAccessToken(revoked.token),
      InvalidTokenError,
    );
    await assert.rejects(
      createAgentTokenVerifier(store, later).verifyAccessToken(expiring.token),
      InvalidTokenError,
    );
  });
});
