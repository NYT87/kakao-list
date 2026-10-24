import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { SyncSnapshot } from "@kakao-lists/domain";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import express from "express";
import { createAgentTokenRouter } from "./agentTokenRoutes.js";
import {
  AGENT_TOKEN_MAX_ACTIVE,
  createAgentTokenVerifier,
  issueAgentToken,
} from "./agentTokens.js";
import { createMcpRouter } from "./mcpServer.js";
import { createInMemoryAgentTokenStore } from "./testing/inMemoryAgentTokenStore.js";

const snapshots: Record<string, SyncSnapshot> = {
  "user-1": {
    syncedAt: "2026-10-20T09:00:00.000Z",
    source: "test",
    lists: [
      {
        id: "busan",
        name: "Busan trip",
        updatedAt: "2026-10-01T00:00:00.000Z",
        itemCount: 2,
        items: [
          { id: "1", title: "Momos Coffee", kakaoNote: "Best latte" },
          { id: "2", title: "Haeundae Beach", localNote: "Go at sunset" },
        ],
      },
    ],
  },
  "user-2": {
    syncedAt: "2026-10-21T09:00:00.000Z",
    source: "test",
    lists: [
      {
        id: "secret",
        name: "User two private list",
        updatedAt: "2026-10-01T00:00:00.000Z",
        itemCount: 1,
        items: [{ id: "9", title: "Private place" }],
      },
    ],
  },
};

// Session auth stand-in: the test passes the user id as the bearer token.
function fakeSessionAuth(
  request: express.Request,
  response: express.Response,
): Promise<string | null> {
  const userId = request.header("authorization")?.replace(/^Bearer /, "");
  if (!userId) {
    response.status(401).send("Missing bearer token.");
    return Promise.resolve(null);
  }
  return Promise.resolve(userId);
}

async function listen(app: express.Express) {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("agent access over HTTP", () => {
  const store = createInMemoryAgentTokenStore();
  let failSnapshotLoad = false;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/agent-tokens",
      createAgentTokenRouter({ store, authenticate: fakeSessionAuth }),
    );
    app.use(
      "/mcp",
      createMcpRouter({
        verifier: createAgentTokenVerifier(store),
        loadSnapshot: async (userId) => {
          if (failSnapshotLoad) {
            throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
          }
          return snapshots[userId] ?? null;
        },
      }),
    );
    ({ server, baseUrl } = await listen(app));
  });

  after(() => {
    server.close();
  });

  async function connect(token: string) {
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  }

  async function issueTokenFor(userId: string) {
    return (
      await issueAgentToken(store, {
        kakaoUserId: userId,
        name: "Test",
        expiresInDays: 30,
      })
    ).token;
  }

  async function callJson(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const result = await client.callTool({ name, arguments: args });
    const [content] = result.content as Array<{ type: string; text: string }>;
    return { isError: result.isError === true, text: content?.text ?? "" };
  }

  describe("token management API", () => {
    it("creates a token once, lists it without the secret, and revokes it", async () => {
      const created = await fetch(`${baseUrl}/api/agent-tokens`, {
        method: "POST",
        headers: {
          Authorization: "Bearer api-user",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Claude Code", expiresInDays: 30 }),
      });
      assert.equal(created.status, 201);
      assert.equal(created.headers.get("cache-control"), "no-store");
      const body = (await created.json()) as {
        token: string;
        agentToken: { id: string; name: string; status: string };
      };
      assert.match(body.token, /^kl_pat_/);
      assert.equal(body.agentToken.name, "Claude Code");
      assert.equal(body.agentToken.status, "active");

      const listed = await fetch(`${baseUrl}/api/agent-tokens`, {
        headers: { Authorization: "Bearer api-user" },
      });
      const listText = await listed.text();
      assert.equal(listed.status, 200);
      assert.equal(listText.includes(body.token), false);
      assert.equal(listText.includes("kakaoUserId"), false);
      const { tokens } = JSON.parse(listText) as {
        tokens: Array<{ id: string }>;
      };
      assert.deepEqual(
        tokens.map((token) => token.id),
        [body.agentToken.id],
      );

      const revoked = await fetch(
        `${baseUrl}/api/agent-tokens/${body.agentToken.id}`,
        { method: "DELETE", headers: { Authorization: "Bearer api-user" } },
      );
      assert.equal(revoked.status, 204);
      await assert.rejects(connect(body.token));
    });

    it("requires a session", async () => {
      const response = await fetch(`${baseUrl}/api/agent-tokens`);
      assert.equal(response.status, 401);
    });

    it("rejects invalid input", async () => {
      const response = await fetch(`${baseUrl}/api/agent-tokens`, {
        method: "POST",
        headers: {
          Authorization: "Bearer api-user",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "", expiresInDays: 1 }),
      });
      assert.equal(response.status, 400);
    });

    it("returns 409 when the active token limit is reached", async () => {
      for (let index = 0; index < AGENT_TOKEN_MAX_ACTIVE; index += 1) {
        await issueTokenFor("limited-user");
      }
      const response = await fetch(`${baseUrl}/api/agent-tokens`, {
        method: "POST",
        headers: {
          Authorization: "Bearer limited-user",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "One too many" }),
      });
      assert.equal(response.status, 409);
    });

    it("does not let a user revoke another user's token", async () => {
      const { record } = await issueAgentToken(store, {
        kakaoUserId: "owner",
        name: "Owner token",
        expiresInDays: 30,
      });

      for (const id of [record.id, "not-a-uuid"]) {
        const response = await fetch(`${baseUrl}/api/agent-tokens/${id}`, {
          method: "DELETE",
          headers: { Authorization: "Bearer intruder" },
        });
        assert.equal(response.status, 404);
      }
      assert.equal((await store.listForUser("owner", new Date())).length, 1);
    });
  });

  describe("MCP endpoint", () => {
    it("rejects requests without a valid token and advertises bearer auth", async () => {
      for (const authorization of [undefined, "Bearer kl_pat_wrong"]) {
        const response = await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(authorization ? { Authorization: authorization } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        assert.equal(response.status, 401);
        assert.match(
          response.headers.get("www-authenticate") ?? "",
          /^Bearer /,
        );
      }
    });

    it("rejects tokens without the lists:read scope", async () => {
      const app = express();
      app.use(express.json());
      const noScopeVerifier: OAuthTokenVerifier = {
        verifyAccessToken: async (token) => ({
          token,
          clientId: "test",
          scopes: [],
          expiresAt: Date.now() / 1000 + 60,
          extra: { kakaoUserId: "user-1" },
        }),
      };
      app.use(
        "/mcp",
        createMcpRouter({
          verifier: noScopeVerifier,
          loadSnapshot: async () => null,
        }),
      );
      const scoped = await listen(app);
      try {
        const response = await fetch(`${scoped.baseUrl}/mcp`, {
          method: "POST",
          headers: {
            Authorization: "Bearer anything",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        assert.equal(response.status, 403);
      } finally {
        scoped.server.close();
      }
    });

    it("rejects GET and DELETE because the server is stateless", async () => {
      for (const method of ["GET", "DELETE"]) {
        const response = await fetch(`${baseUrl}/mcp`, {
          method,
          headers: { Authorization: `Bearer ${await issueTokenFor("user-1")}` },
        });
        assert.equal(response.status, 405);
      }
    });

    it("exposes four read-only tools", async () => {
      const client = await connect(await issueTokenFor("user-1"));
      const { tools } = await client.listTools();

      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        "get_list",
        "get_place",
        "list_lists",
        "search_places",
      ]);
      for (const tool of tools) {
        assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      }
      await client.close();
    });

    it("answers from the token owner's snapshot only", async () => {
      const client = await connect(await issueTokenFor("user-1"));

      const lists = await callJson(client, "list_lists");
      assert.equal(lists.isError, false);
      assert.deepEqual(JSON.parse(lists.text), {
        syncedAt: "2026-10-20T09:00:00.000Z",
        lists: [
          {
            id: "busan",
            name: "Busan trip",
            updatedAt: "2026-10-01T00:00:00.000Z",
            placeCount: 2,
          },
        ],
      });

      const otherUsersList = await callJson(client, "get_list", {
        listId: "secret",
      });
      assert.equal(otherUsersList.isError, true);
      assert.equal(otherUsersList.text.includes("Private place"), false);
      await client.close();
    });

    it("pages through a list", async () => {
      const client = await connect(await issueTokenFor("user-1"));

      const page = JSON.parse(
        (await callJson(client, "get_list", { listId: "busan", limit: 1 }))
          .text,
      );
      assert.deepEqual(
        page.places.map((place: { id: string }) => place.id),
        ["1"],
      );
      assert.equal(page.nextOffset, 1);
      await client.close();
    });

    it("searches places and returns one place", async () => {
      const client = await connect(await issueTokenFor("user-1"));

      const search = JSON.parse(
        (await callJson(client, "search_places", { query: "sunset" })).text,
      );
      assert.deepEqual(
        search.places.map((place: { id: string }) => place.id),
        ["2"],
      );

      const place = await callJson(client, "get_place", {
        listId: "busan",
        placeId: "1",
      });
      assert.deepEqual(JSON.parse(place.text), {
        syncedAt: "2026-10-20T09:00:00.000Z",
        place: {
          listId: "busan",
          listName: "Busan trip",
          id: "1",
          title: "Momos Coffee",
          kakaoNote: "Best latte",
        },
      });

      const missing = await callJson(client, "get_place", {
        listId: "busan",
        placeId: "404",
      });
      assert.equal(missing.isError, true);
      await client.close();
    });

    it("validates tool input bounds", async () => {
      const client = await connect(await issueTokenFor("user-1"));

      const tooMany = await callJson(client, "get_list", {
        listId: "busan",
        limit: 1000,
      });
      const blankQuery = await callJson(client, "search_places", { query: "" });

      assert.equal(tooMany.isError, true);
      assert.equal(blankQuery.isError, true);
      await client.close();
    });

    it("explains how to import when the user has no synced lists", async () => {
      const client = await connect(await issueTokenFor("user-without-data"));

      const lists = JSON.parse((await callJson(client, "list_lists")).text);
      assert.equal(lists.syncedAt, null);
      assert.deepEqual(lists.lists, []);
      assert.match(lists.hint, /extension/i);
      await client.close();
    });

    it("hides storage errors from the agent", async () => {
      const client = await connect(await issueTokenFor("user-1"));
      failSnapshotLoad = true;
      try {
        const result = await callJson(client, "list_lists");
        assert.equal(result.isError, true);
        assert.equal(result.text.includes("ECONNREFUSED"), false);
      } finally {
        failSnapshotLoad = false;
        await client.close();
      }
    });
  });
});
