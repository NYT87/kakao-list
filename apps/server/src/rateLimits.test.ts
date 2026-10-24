import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import express from "express";
import { createAgentTokenVerifier, issueAgentToken } from "./agentTokens.js";
import { createAgentVerifier } from "./agentVerifier.js";
import { createKakaoOAuth } from "./kakaoOAuth.js";
import { createMcpRouter } from "./mcpServer.js";
import { createApiRateLimit, createMcpRateLimits } from "./rateLimits.js";
import { createInMemoryAgentTokenStore } from "./testing/inMemoryAgentTokenStore.js";
import { createInMemoryOAuthStore } from "./testing/inMemoryOAuthStore.js";
import { createRecordingStoreFactory } from "./testing/recordingRateLimitStore.js";

const servers: Server[] = [];

async function listen(app: express.Express) {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

after(() => {
  for (const server of servers) {
    server.close();
  }
});

function callMcp(baseUrl: string, token?: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

async function startMcp(limits: {
  perIp: number;
  perUser: number;
  failing?: boolean;
}) {
  const patStore = createInMemoryAgentTokenStore();
  const stores = createRecordingStoreFactory({ failing: limits.failing });
  const app = express();
  app.use(express.json());
  app.use(
    "/mcp",
    createMcpRouter({
      verifier: createAgentVerifier({
        agentTokens: createAgentTokenVerifier(patStore),
      }),
      loadSnapshot: async () => null,
      rateLimits: createMcpRateLimits({
        createStore: stores.createStore,
        perIpPerMinute: limits.perIp,
        perUserPerMinute: limits.perUser,
      }),
    }),
  );
  const baseUrl = await listen(app);
  const tokenFor = async (kakaoUserId: string) =>
    (
      await issueAgentToken(patStore, {
        kakaoUserId,
        name: "Test",
        expiresInDays: 30,
      })
    ).token;
  return { baseUrl, tokenFor, stores };
}

describe("/mcp rate limits", () => {
  it("limits each user separately once authenticated", async () => {
    const { baseUrl, tokenFor } = await startMcp({ perIp: 100, perUser: 2 });
    const first = await tokenFor("user-1");
    const second = await tokenFor("user-2");

    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await callMcp(baseUrl, first)).status);
    }
    const otherUser = await callMcp(baseUrl, second);

    assert.deepEqual(statuses, [200, 200, 429]);
    assert.equal(otherUser.status, 200);
  });

  it("answers 429 with a JSON-RPC error and retry information", async () => {
    const { baseUrl, tokenFor } = await startMcp({ perIp: 100, perUser: 1 });
    const token = await tokenFor("user-1");
    await callMcp(baseUrl, token);

    const limited = await callMcp(baseUrl, token);

    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    const body = (await limited.json()) as {
      jsonrpc: string;
      error: { message: string };
    };
    assert.equal(body.jsonrpc, "2.0");
    assert.match(body.error.message, /too many requests/i);
  });

  it("limits each IP address before authentication", async () => {
    const { baseUrl } = await startMcp({ perIp: 2, perUser: 100 });

    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await callMcp(baseUrl)).status);
    }

    assert.deepEqual(statuses, [401, 401, 429]);
  });

  it("counts users by Kakao id, not by token", async () => {
    const { baseUrl, tokenFor, stores } = await startMcp({
      perIp: 100,
      perUser: 100,
    });

    await callMcp(baseUrl, await tokenFor("user-1"));
    await callMcp(baseUrl, await tokenFor("user-1"));

    assert.deepEqual(stores.keysFor("mcp-user:"), ["user-1"]);
  });

  it("lets requests through when the rate limit store is unavailable", async () => {
    const { baseUrl, tokenFor } = await startMcp({
      perIp: 1,
      perUser: 1,
      failing: true,
    });
    const token = await tokenFor("user-1");

    await callMcp(baseUrl, token);
    assert.equal((await callMcp(baseUrl, token)).status, 200);
  });
});

describe("OAuth endpoint rate limits", () => {
  async function startOAuth(options: { callbackPerIp?: number } = {}) {
    const stores = createRecordingStoreFactory();
    const app = express();
    const baseUrl = await listen(app);
    const oauth = createKakaoOAuth({
      store: createInMemoryOAuthStore(),
      publicUrl: new URL(baseUrl),
      kakaoClientId: "kakao-app-key",
      kakaoAuthorizeEndpoint: "https://kauth.example/oauth/authorize",
      identifyKakaoUser: async () => "user-1",
      rateLimit: {
        createStore: stores.createStore,
        callbackPerIpPer15Minutes: options.callbackPerIp,
      },
    });
    app.use(express.json());
    app.use(oauth.router);
    return { baseUrl, stores };
  }

  it("uses one shared-store limiter per OAuth endpoint", async () => {
    const { baseUrl, stores } = await startOAuth();

    await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:1/cb"] }),
    });
    await fetch(`${baseUrl}/authorize?client_id=x`, { redirect: "manual" });
    for (const path of ["/token", "/revoke"]) {
      await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "client_id=x",
      });
    }
    await fetch(`${baseUrl}/oauth/kakao/callback?state=x`, {
      redirect: "manual",
    });

    assert.deepEqual([...stores.prefixes].sort(), [
      "oauth-authorize:",
      "oauth-callback:",
      "oauth-register:",
      "oauth-revoke:",
      "oauth-token:",
    ]);
    for (const prefix of stores.prefixes) {
      assert.equal(stores.keysFor(prefix).length, 1, prefix);
    }
  });

  it("limits Kakao callbacks per IP with a readable page", async () => {
    const { baseUrl } = await startOAuth({ callbackPerIp: 2 });
    const callback = () =>
      fetch(`${baseUrl}/oauth/kakao/callback?state=x`, { redirect: "manual" });

    await callback();
    await callback();
    const limited = await callback();

    assert.equal(limited.status, 429);
    assert.match(limited.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await limited.text(), /too many sign-in attempts/i);
  });
});

describe("agent management API rate limit", () => {
  it("limits each IP address with a plain-text 429", async () => {
    const stores = createRecordingStoreFactory();
    const app = express();
    app.use(
      "/api/agent-tokens",
      createApiRateLimit({
        createStore: stores.createStore,
        prefix: "api-agent-tokens:",
        perIpPerMinute: 2,
      }),
      (_request, response) => {
        response.json({ tokens: [] });
      },
    );
    const baseUrl = await listen(app);

    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await fetch(`${baseUrl}/api/agent-tokens`)).status);
    }
    const limited = await fetch(`${baseUrl}/api/agent-tokens`);

    assert.deepEqual(statuses, [200, 200, 429]);
    assert.match(await limited.text(), /too many requests/i);
    assert.deepEqual(stores.prefixes, ["api-agent-tokens:"]);
  });
});
