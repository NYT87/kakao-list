import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { SyncSnapshot } from "@kakao-lists/domain";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import express from "express";
import { createAgentConnectionRouter } from "./agentConnectionRoutes.js";
import { createAgentTokenVerifier, issueAgentToken } from "./agentTokens.js";
import { createAgentVerifier } from "./agentVerifier.js";
import { createKakaoOAuth, OAUTH_MAX_ACTIVE_GRANTS } from "./kakaoOAuth.js";
import { createMcpRouter } from "./mcpServer.js";
import { createInMemoryAgentTokenStore } from "./testing/inMemoryAgentTokenStore.js";
import { createInMemoryOAuthStore } from "./testing/inMemoryOAuthStore.js";

const CLIENT_REDIRECT = "http://localhost:4567/oauth/callback";
const KAKAO_AUTHORIZE = "https://kauth.example/oauth/authorize";

const snapshots: Record<string, SyncSnapshot> = {
  "user-1": {
    syncedAt: "2026-10-20T09:00:00.000Z",
    source: "test",
    lists: [
      {
        id: "busan",
        name: "Busan trip",
        updatedAt: "2026-10-01T00:00:00.000Z",
        itemCount: 1,
        items: [{ id: "1", title: "Momos Coffee" }],
      },
    ],
  },
};

// Session auth stand-in for the PWA endpoints: the bearer value is the user id.
async function fakeSessionAuth(
  request: express.Request,
  response: express.Response,
) {
  const userId = request.header("authorization")?.replace(/^Bearer /, "");
  if (!userId) {
    response.status(401).send("Missing bearer token.");
    return null;
  }
  return userId;
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

describe("OAuth sign-in with Kakao for MCP clients", () => {
  let server: Server;
  let baseUrl: string;
  let clock: Date;
  let failKakao = false;
  const kakaoCodes = new Map<string, string>();
  const store = createInMemoryOAuthStore();
  const patStore = createInMemoryAgentTokenStore();

  before(async () => {
    const app = express();
    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    const oauth = createKakaoOAuth({
      store,
      publicUrl: new URL(baseUrl),
      kakaoClientId: "kakao-app-key",
      kakaoAuthorizeEndpoint: KAKAO_AUTHORIZE,
      identifyKakaoUser: async (code, redirectUri) => {
        assert.equal(redirectUri, `${baseUrl}/oauth/kakao/callback`);
        if (failKakao) {
          throw new Error("kakao exploded: secret-internal-detail");
        }
        const userId = kakaoCodes.get(code);
        if (!userId) {
          throw new Error("unknown Kakao code");
        }
        return userId;
      },
      now: () => clock,
      rateLimit: false,
    });

    app.use(express.json());
    app.use(oauth.router);
    app.use(
      "/api/agent-connections",
      createAgentConnectionRouter({
        store,
        authenticate: fakeSessionAuth,
        now: () => clock,
      }),
    );
    app.use(
      "/mcp",
      createMcpRouter({
        verifier: createAgentVerifier({
          agentTokens: createAgentTokenVerifier(patStore),
          oauth: oauth.verifier,
          resource: oauth.mcpResourceUrl,
        }),
        loadSnapshot: async (userId) => snapshots[userId] ?? null,
        resourceMetadataUrl: oauth.resourceMetadataUrl,
        expectedResource: oauth.mcpResourceUrl,
      }),
    );
  });

  after(() => {
    server.close();
  });

  beforeEach(() => {
    clock = new Date();
    failKakao = false;
  });

  async function register(metadata: Record<string, unknown> = {}) {
    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Assistant",
        redirect_uris: [CLIENT_REDIRECT],
        ...metadata,
      }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  async function registerClient(metadata: Record<string, unknown> = {}) {
    const { status, body } = await register(metadata);
    assert.equal(status, 201, JSON.stringify(body));
    return body as { client_id: string } & Record<string, unknown>;
  }

  async function startAuthorization(
    clientId: string,
    params: Record<string, string> = {},
  ) {
    const { verifier, challenge } = pkcePair();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "client-state-123",
      ...params,
    });
    const response = await fetch(`${baseUrl}/authorize?${query}`, {
      redirect: "manual",
    });
    const html = response.status === 200 ? await response.text() : "";
    const cookie = response.headers.get("set-cookie") ?? "";
    const kakaoHref = html.match(/href="(https:\/\/kauth\.example[^"]+)"/)?.[1];
    const kakaoUrl = kakaoHref
      ? new URL(kakaoHref.replaceAll("&amp;", "&"))
      : null;
    return { response, html, cookie, kakaoUrl, verifier };
  }

  async function kakaoCallback(
    state: string,
    cookie: string,
    params: Record<string, string>,
  ) {
    const query = new URLSearchParams({ state, ...params });
    return fetch(`${baseUrl}/oauth/kakao/callback?${query}`, {
      redirect: "manual",
      headers: cookie ? { Cookie: cookie.split(";")[0] as string } : {},
    });
  }

  async function authorizeAs(userId: string, clientId?: string) {
    const client = clientId ? { client_id: clientId } : await registerClient();
    const started = await startAuthorization(client.client_id);
    assert.ok(started.kakaoUrl, "consent page links to Kakao");
    const kakaoCode = `kakao-${crypto.randomUUID()}`;
    kakaoCodes.set(kakaoCode, userId);
    const callback = await kakaoCallback(
      started.kakaoUrl.searchParams.get("state") as string,
      started.cookie,
      { code: kakaoCode },
    );
    assert.equal(callback.status, 302);
    const location = new URL(callback.headers.get("location") as string);
    return {
      clientId: client.client_id,
      verifier: started.verifier,
      code: location.searchParams.get("code") as string,
      location,
    };
  }

  async function tokenRequest(body: Record<string, string>) {
    const response = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  async function exchange(flow: {
    clientId: string;
    verifier: string;
    code: string;
  }) {
    return tokenRequest({
      grant_type: "authorization_code",
      client_id: flow.clientId,
      code: flow.code,
      code_verifier: flow.verifier,
      redirect_uri: CLIENT_REDIRECT,
    });
  }

  async function connectedTokens(userId = "user-1") {
    const flow = await authorizeAs(userId);
    const { status, body } = await exchange(flow);
    assert.equal(status, 200, JSON.stringify(body));
    return { ...flow, tokens: body as unknown as OAuthTokens };
  }

  async function callMcp(accessToken: string) {
    return fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  }

  describe("discovery", () => {
    it("advertises authorization server metadata", async () => {
      const response = await fetch(
        `${baseUrl}/.well-known/oauth-authorization-server`,
      );
      const metadata = (await response.json()) as Record<string, unknown>;

      assert.equal(metadata.issuer, `${baseUrl}/`);
      assert.equal(metadata.authorization_endpoint, `${baseUrl}/authorize`);
      assert.equal(metadata.token_endpoint, `${baseUrl}/token`);
      assert.equal(metadata.registration_endpoint, `${baseUrl}/register`);
      assert.equal(metadata.revocation_endpoint, `${baseUrl}/revoke`);
      assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
      assert.deepEqual(metadata.token_endpoint_auth_methods_supported, [
        "none",
      ]);
      assert.deepEqual(metadata.revocation_endpoint_auth_methods_supported, [
        "none",
      ]);
      assert.deepEqual(metadata.scopes_supported, ["lists:read"]);
    });

    it("advertises protected resource metadata for /mcp", async () => {
      const response = await fetch(
        `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
      );
      const metadata = (await response.json()) as Record<string, unknown>;

      assert.equal(metadata.resource, `${baseUrl}/mcp`);
      assert.deepEqual(metadata.authorization_servers, [`${baseUrl}/`]);
    });

    it("points unauthenticated MCP requests at the resource metadata", async () => {
      const response = await callMcp("kl_at_missing");

      assert.equal(response.status, 401);
      assert.match(
        response.headers.get("www-authenticate") ?? "",
        new RegExp(
          `resource_metadata="${baseUrl}/\\.well-known/oauth-protected-resource/mcp"`,
        ),
      );
    });
  });

  describe("client registration", () => {
    it("registers every client as a public PKCE client without a secret", async () => {
      const client = await registerClient({
        token_endpoint_auth_method: "client_secret_post",
      });

      assert.equal(client.token_endpoint_auth_method, "none");
      assert.equal(client.client_secret, undefined);
      assert.deepEqual(client.grant_types, [
        "authorization_code",
        "refresh_token",
      ]);
    });

    const redirectCases: Array<[string, boolean]> = [
      ["https://claude.ai/api/mcp/auth_callback", true],
      ["http://localhost:33418/callback", true],
      ["http://127.0.0.1:6274/oauth/callback", true],
      ["com.example.assistant:/oauth/callback", true],
      ["http://evil.example/callback", false],
      ["javascript:alert(1)", false],
      ["myapp:/callback", false],
      ["https://user:pass@claude.ai/callback", false],
      ["https://claude.ai/callback#fragment", false],
    ];
    for (const [uri, allowed] of redirectCases) {
      it(`${allowed ? "accepts" : "rejects"} redirect URI ${uri}`, async () => {
        const { status } = await register({ redirect_uris: [uri] });
        assert.equal(status, allowed ? 201 : 400);
      });
    }

    it("rejects oversized registrations", async () => {
      const longName = await register({ client_name: "x".repeat(101) });
      const manyUris = await register({
        redirect_uris: Array.from(
          { length: 11 },
          (_, index) => `http://localhost:${4000 + index}/cb`,
        ),
      });
      const noUris = await register({ redirect_uris: [] });

      assert.equal(longName.status, 400);
      assert.equal(manyUris.status, 400);
      assert.equal(noUris.status, 400);
    });
  });

  describe("authorization and consent", () => {
    it("shows a consent page that names the assistant and links to Kakao", async () => {
      const client = await registerClient({
        client_name: '<img src=x onerror="alert(1)">',
      });
      const { response, html, cookie, kakaoUrl } = await startAuthorization(
        client.client_id,
      );

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.match(
        response.headers.get("content-security-policy") ?? "",
        /frame-ancestors 'none'/,
      );
      assert.equal(html.includes("<img"), false);
      assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
      assert.match(html, /localhost:4567/);
      assert.match(html, /read-only/i);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
      assert.match(cookie, /Path=\/oauth\/kakao\/callback/);
      assert.ok(kakaoUrl);
      assert.equal(kakaoUrl.searchParams.get("client_id"), "kakao-app-key");
      assert.equal(kakaoUrl.searchParams.get("response_type"), "code");
      assert.equal(
        kakaoUrl.searchParams.get("redirect_uri"),
        `${baseUrl}/oauth/kakao/callback`,
      );
      assert.ok(cookie.includes(kakaoUrl.searchParams.get("state") as string));
    });

    it("offers a cancel link that returns access_denied to the client", async () => {
      const client = await registerClient();
      const { html } = await startAuthorization(client.client_id);
      const cancelHref = html
        .match(/href="(http:\/\/localhost:4567[^"]+)"/)?.[1]
        ?.replaceAll("&amp;", "&");

      assert.ok(cancelHref);
      const cancel = new URL(cancelHref);
      assert.equal(cancel.searchParams.get("error"), "access_denied");
      assert.equal(cancel.searchParams.get("state"), "client-state-123");
    });

    it("rejects unsupported scopes with a redirect error", async () => {
      const client = await registerClient();
      const { response } = await startAuthorization(client.client_id, {
        scope: "lists:read lists:write",
      });

      assert.equal(response.status, 302);
      const location = new URL(response.headers.get("location") as string);
      assert.equal(location.searchParams.get("error"), "invalid_scope");
      assert.equal(location.searchParams.get("state"), "client-state-123");
    });

    it("rejects tokens requested for another resource", async () => {
      const client = await registerClient();
      const { response } = await startAuthorization(client.client_id, {
        resource: "https://other.example/mcp",
      });

      const location = new URL(response.headers.get("location") as string);
      assert.equal(location.searchParams.get("error"), "invalid_target");
    });

    it("refuses unregistered redirect URIs without redirecting", async () => {
      const client = await registerClient();
      const { response } = await startAuthorization(client.client_id, {
        redirect_uri: "https://attacker.example/callback",
      });

      assert.equal(response.status, 400);
      assert.equal(response.headers.get("location"), null);
    });
  });

  describe("Kakao callback", () => {
    it("redirects back to the client with a code and its original state", async () => {
      const { location, code } = await authorizeAs("user-1");

      assert.equal(`${location.origin}${location.pathname}`, CLIENT_REDIRECT);
      assert.equal(location.searchParams.get("state"), "client-state-123");
      assert.match(code, /^kl_ac_/);
    });

    it("leaves a newer sign-in's cookie alone when a stale callback arrives", async () => {
      const client = await registerClient();
      const older = await startAuthorization(client.client_id);
      const newer = await startAuthorization(client.client_id);
      kakaoCodes.set("kakao-overlap", "user-1");

      const stale = await kakaoCallback(
        older.kakaoUrl?.searchParams.get("state") as string,
        newer.cookie,
        { code: "kakao-overlap" },
      );
      const current = await kakaoCallback(
        newer.kakaoUrl?.searchParams.get("state") as string,
        newer.cookie,
        { code: "kakao-overlap" },
      );

      assert.equal(stale.status, 400);
      assert.equal(stale.headers.get("set-cookie"), null);
      assert.equal(current.status, 302);
      assert.ok(
        new URL(current.headers.get("location") as string).searchParams.get(
          "code",
        ),
      );
    });

    it("clears the state cookie", async () => {
      const client = await registerClient();
      const started = await startAuthorization(client.client_id);
      kakaoCodes.set("kakao-clear", "user-1");
      const callback = await kakaoCallback(
        started.kakaoUrl?.searchParams.get("state") as string,
        started.cookie,
        { code: "kakao-clear" },
      );

      assert.match(callback.headers.get("set-cookie") ?? "", /Max-Age=0/);
    });

    it("rejects a callback without the matching browser cookie", async () => {
      const client = await registerClient();
      const started = await startAuthorization(client.client_id);
      const state = started.kakaoUrl?.searchParams.get("state") as string;
      kakaoCodes.set("kakao-no-cookie", "user-1");

      const missing = await kakaoCallback(state, "", {
        code: "kakao-no-cookie",
      });
      const wrong = await kakaoCallback(
        state,
        "kl_oauth_request=someone-else",
        { code: "kakao-no-cookie" },
      );

      for (const response of [missing, wrong]) {
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("location"), null);
      }
    });

    it("accepts each sign-in attempt only once", async () => {
      const client = await registerClient();
      const started = await startAuthorization(client.client_id);
      const state = started.kakaoUrl?.searchParams.get("state") as string;
      kakaoCodes.set("kakao-once-a", "user-1");
      kakaoCodes.set("kakao-once-b", "user-1");

      const first = await kakaoCallback(state, started.cookie, {
        code: "kakao-once-a",
      });
      const second = await kakaoCallback(state, started.cookie, {
        code: "kakao-once-b",
      });

      assert.equal(first.status, 302);
      assert.equal(second.status, 400);
    });

    it("expires sign-in attempts after 10 minutes", async () => {
      const client = await registerClient();
      const started = await startAuthorization(client.client_id);
      kakaoCodes.set("kakao-late", "user-1");
      clock = new Date(clock.getTime() + 11 * 60 * 1000);

      const callback = await kakaoCallback(
        started.kakaoUrl?.searchParams.get("state") as string,
        started.cookie,
        { code: "kakao-late" },
      );

      assert.equal(callback.status, 400);
    });

    it("returns access_denied when the user cancels on Kakao", async () => {
      const client = await registerClient();
      const started = await startAuthorization(client.client_id);

      const callback = await kakaoCallback(
        started.kakaoUrl?.searchParams.get("state") as string,
        started.cookie,
        { error: "access_denied", error_description: "User denied access" },
      );

      const location = new URL(callback.headers.get("location") as string);
      assert.equal(location.searchParams.get("error"), "access_denied");
      assert.equal(location.searchParams.get("state"), "client-state-123");
      assert.equal(location.searchParams.get("code"), null);
    });

    it("returns a generic server_error when Kakao sign-in fails", async () => {
      const client = await registerClient();
      const started = await startAuthorization(client.client_id);
      failKakao = true;

      const callback = await kakaoCallback(
        started.kakaoUrl?.searchParams.get("state") as string,
        started.cookie,
        { code: "anything" },
      );

      const location = callback.headers.get("location") as string;
      assert.match(location, /error=server_error/);
      assert.equal(location.includes("secret-internal-detail"), false);
    });

    it(`allows at most ${OAUTH_MAX_ACTIVE_GRANTS} connected assistants per user`, async () => {
      for (let index = 0; index < OAUTH_MAX_ACTIVE_GRANTS; index += 1) {
        await connectedTokens("busy-user");
      }

      const { location } = await authorizeAs("busy-user");

      assert.equal(location.searchParams.get("error"), "access_denied");
      assert.match(
        location.searchParams.get("error_description") ?? "",
        /disconnect/i,
      );
    });
  });

  describe("token endpoint", () => {
    it("exchanges a code for access and refresh tokens that work on /mcp", async () => {
      const { tokens } = await connectedTokens();

      assert.equal(tokens.token_type, "Bearer");
      assert.equal(tokens.expires_in, 3600);
      assert.equal(tokens.scope, "lists:read");
      assert.match(tokens.access_token, /^kl_at_/);
      assert.match(tokens.refresh_token ?? "", /^kl_rt_/);

      const response = await callMcp(tokens.access_token);
      assert.equal(response.status, 200);
    });

    it("rejects a wrong PKCE verifier", async () => {
      const flow = await authorizeAs("user-1");

      const { status, body } = await exchange({
        ...flow,
        verifier: pkcePair().verifier,
      });

      assert.equal(status, 400);
      assert.equal(body.error, "invalid_grant");
    });

    it("rejects a code issued to another client", async () => {
      const flow = await authorizeAs("user-1");
      const other = await registerClient();

      const { status, body } = await exchange({
        ...flow,
        clientId: other.client_id,
      });

      assert.equal(status, 400);
      assert.equal(body.error, "invalid_grant");
    });

    it("rejects expired codes", async () => {
      const flow = await authorizeAs("user-1");
      clock = new Date(clock.getTime() + 2 * 60 * 1000);

      const { status, body } = await exchange(flow);

      assert.equal(status, 400);
      assert.equal(body.error, "invalid_grant");
    });

    it("revokes the connection when a code is used twice", async () => {
      const flow = await authorizeAs("user-1");
      const first = await exchange(flow);
      const second = await exchange(flow);

      assert.equal(second.status, 400);
      assert.equal(second.body.error, "invalid_grant");
      const response = await callMcp(first.body.access_token as string);
      assert.equal(response.status, 401);
    });

    it("revokes the connection when a code is replayed concurrently", async () => {
      const flow = await authorizeAs("user-1");

      const results = await Promise.all([exchange(flow), exchange(flow)]);

      assert.deepEqual(
        results.map((result) => result.status).sort(),
        [200, 400],
      );
      const winner = results.find((result) => result.status === 200);
      assert.equal(
        (await callMcp(winner?.body.access_token as string)).status,
        401,
      );
    });

    it("still revokes the connection when an old code is replayed after cleanup", async () => {
      const flow = await authorizeAs("user-1");
      const first = await exchange(flow);
      clock = new Date(clock.getTime() + 2 * 60 * 1000);
      // Saving a newer code purges expired codes.
      await authorizeAs("user-1");

      const replay = await exchange(flow);

      assert.equal(replay.status, 400);
      assert.equal(replay.body.error, "invalid_grant");
      assert.equal(
        (await callMcp(first.body.access_token as string)).status,
        401,
      );
    });

    it("rotates refresh tokens", async () => {
      const { clientId, tokens } = await connectedTokens();

      const refreshed = await tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token as string,
      });

      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
      assert.notEqual(refreshed.body.refresh_token, tokens.refresh_token);
      assert.notEqual(refreshed.body.access_token, tokens.access_token);
      assert.equal(
        (await callMcp(refreshed.body.access_token as string)).status,
        200,
      );
    });

    it("revokes the connection when an old refresh token is reused", async () => {
      const { clientId, tokens } = await connectedTokens();
      const refreshed = await tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token as string,
      });

      const replay = await tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token as string,
      });

      assert.equal(replay.status, 400);
      assert.equal(replay.body.error, "invalid_grant");
      assert.equal(
        (await callMcp(refreshed.body.access_token as string)).status,
        401,
      );
    });

    it("rejects refresh tokens presented by another client", async () => {
      const { tokens } = await connectedTokens();
      const other = await registerClient();

      const { status, body } = await tokenRequest({
        grant_type: "refresh_token",
        client_id: other.client_id,
        refresh_token: tokens.refresh_token as string,
      });

      assert.equal(status, 400);
      assert.equal(body.error, "invalid_grant");
    });

    it("rejects scope escalation on refresh", async () => {
      const { clientId, tokens } = await connectedTokens();

      const { status, body } = await tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token as string,
        scope: "lists:read lists:sync",
      });

      assert.equal(status, 400);
      assert.equal(body.error, "invalid_scope");
    });

    it("expires access tokens after an hour", async () => {
      const { tokens } = await connectedTokens();
      clock = new Date(clock.getTime() + 61 * 60 * 1000);

      assert.equal((await callMcp(tokens.access_token)).status, 401);
    });

    it("revokes the connection through the revocation endpoint", async () => {
      const { clientId, tokens } = await connectedTokens();

      const response = await fetch(`${baseUrl}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          token: tokens.refresh_token as string,
        }),
      });

      assert.equal(response.status, 200);
      assert.equal((await callMcp(tokens.access_token)).status, 401);
    });
  });

  describe("connections API for the web app", () => {
    it("lists the user's connections and disconnects one", async () => {
      const { tokens } = await connectedTokens("listing-user");
      await callMcp(tokens.access_token);
      await connectedTokens("someone-else");

      const listed = await fetch(`${baseUrl}/api/agent-connections`, {
        headers: { Authorization: "Bearer listing-user" },
      });
      const { connections } = (await listed.json()) as {
        connections: Array<Record<string, unknown>>;
      };

      assert.equal(connections.length, 1);
      const [connection] = connections;
      assert.equal(connection?.clientName, "Test Assistant");
      assert.deepEqual(connection?.scopes, ["lists:read"]);
      assert.equal(connection?.lastUsedAt, clock.toISOString());
      assert.equal(JSON.stringify(connections).includes("kl_"), false);

      const foreign = await fetch(
        `${baseUrl}/api/agent-connections/${connection?.id}`,
        { method: "DELETE", headers: { Authorization: "Bearer someone-else" } },
      );
      assert.equal(foreign.status, 404);

      const revoked = await fetch(
        `${baseUrl}/api/agent-connections/${connection?.id}`,
        { method: "DELETE", headers: { Authorization: "Bearer listing-user" } },
      );
      assert.equal(revoked.status, 204);
      assert.equal((await callMcp(tokens.access_token)).status, 401);
    });

    it("requires a session", async () => {
      const response = await fetch(`${baseUrl}/api/agent-connections`);
      assert.equal(response.status, 401);
    });
  });

  it("keeps accepting personal agent tokens on /mcp", async () => {
    const { token } = await issueAgentToken(patStore, {
      kakaoUserId: "user-1",
      name: "Key",
      expiresInDays: 30,
    });

    assert.equal((await callMcp(token)).status, 200);
  });

  it("works end to end with the MCP SDK client's OAuth flow", async () => {
    let clientInformation: OAuthClientInformationMixed | undefined;
    let savedTokens: OAuthTokens | undefined;
    let codeVerifier = "";
    let authorizationUrl: URL | undefined;
    const authProvider = {
      redirectUrl: CLIENT_REDIRECT,
      clientMetadata: {
        client_name: "SDK Client",
        redirect_uris: [CLIENT_REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      clientInformation: () => clientInformation,
      saveClientInformation: (info: OAuthClientInformationMixed) => {
        clientInformation = info;
      },
      tokens: () => savedTokens,
      saveTokens: (tokens: OAuthTokens) => {
        savedTokens = tokens;
      },
      redirectToAuthorization: (url: URL) => {
        authorizationUrl = url;
      },
      saveCodeVerifier: (verifier: string) => {
        codeVerifier = verifier;
      },
      codeVerifier: () => codeVerifier,
    };
    const mcpUrl = new URL(`${baseUrl}/mcp`);

    const firstTransport = new StreamableHTTPClientTransport(mcpUrl, {
      authProvider,
    });
    await assert.rejects(
      new Client({ name: "sdk", version: "1" }).connect(firstTransport),
      UnauthorizedError,
    );
    assert.ok(authorizationUrl, "SDK client was sent to /authorize");

    // The user's browser: consent page → Kakao → our callback.
    const consent = await fetch(authorizationUrl, { redirect: "manual" });
    const html = await consent.text();
    const kakaoHref = html
      .match(/href="(https:\/\/kauth\.example[^"]+)"/)?.[1]
      ?.replaceAll("&amp;", "&");
    assert.ok(kakaoHref);
    kakaoCodes.set("kakao-sdk", "user-1");
    const callback = await kakaoCallback(
      new URL(kakaoHref).searchParams.get("state") as string,
      consent.headers.get("set-cookie") ?? "",
      { code: "kakao-sdk" },
    );
    const code = new URL(
      callback.headers.get("location") as string,
    ).searchParams.get("code");
    assert.ok(code);

    await firstTransport.finishAuth(code);
    const client = new Client({ name: "sdk", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(mcpUrl, { authProvider }),
    );
    const result = await client.callTool({ name: "list_lists", arguments: {} });
    const [content] = result.content as Array<{ text: string }>;
    assert.equal(JSON.parse(content?.text ?? "{}").lists[0].name, "Busan trip");
    await client.close();
  });
});
