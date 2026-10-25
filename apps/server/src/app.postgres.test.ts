import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import type { SyncSnapshot } from "@kakao-lists/domain";
import { Pool } from "pg";
import {
  AgentTokenLimitError,
  createPostgresAgentTokenStore,
  issueAgentToken,
} from "./agentTokens.js";
import { createApplication } from "./app.js";
import { credentialVault } from "./security.js";

type ApiResponse = Omit<Response, "json"> & {
  json(): Promise<{
    snapshot: SyncSnapshot;
    serverVersion: number;
    token: string;
    user: { id: string };
    error: { message: string };
  }>;
};
const databaseUrl = process.env.TEST_DATABASE_URL;
const secret = `test-only-secret-${"a".repeat(64)}`;
const at = "2026-10-25T00:00:00.000Z";
const list = (id = "list-1") => ({
  id,
  name: id,
  updatedAt: at,
  itemCount: 2,
  items: [
    { id: "one", title: "One" },
    { id: "two", title: "Two" },
  ],
});
const snapshot = (id = "list-1") => ({
  syncedAt: at,
  source: "test-import",
  lists: [list(id)],
});
describe("main API with real PostgreSQL", { skip: !databaseUrl }, () => {
  let pool: Pool,
    admin: Pool,
    runtime: ReturnType<typeof createApplication>,
    server: Server,
    base: string;
  const schema = `main_api_test_${crypto.randomBytes(6).toString("hex")}`;
  before(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 20,
    });
    runtime = createApplication({
      pool,
      env: {
        SYNC_SERVER_SIGNING_SECRET: secret,
        ALLOW_MOCK_AUTH: "true",
        KAKAO_REST_API_KEY: "fixture-client",
      },
      kakaoAuthUrl: process.env.KAKAO_SIMULATION_URL,
      kakaoApiUrl: process.env.KAKAO_SIMULATION_URL,
    });
    await runtime.ensureServerReady();
    server = await new Promise<Server>((resolve, reject) => {
      const running = runtime.app.listen(0, "127.0.0.1", () =>
        resolve(running),
      );
      running.once("error", reject);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    await runtime?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function call(
    path: string,
    token?: string,
    method = "GET",
    body?: unknown,
  ) {
    return fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }) as Promise<ApiResponse>;
  }
  async function login(id: string) {
    const response = await call("/api/auth/mock", undefined, "POST", {
      userId: id,
    });
    assert.equal(response.status, 200);
    return (await response.json()) as { token: string; user: { id: string } };
  }
  async function seed(token: string, id = "list-1") {
    const response = await call("/api/snapshot", token, "PUT", {
      deviceId: "test",
      snapshot: snapshot(id),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  it("does not accept public-default-signed tokens", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        user: { id: "victim" },
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    ).toString("base64url");
    const forged = `${payload}.${crypto.createHmac("sha256", "change-me-in-production").update(payload).digest("base64url")}`;
    assert.equal((await call("/api/snapshot", forged)).status, 401);
  });
  it("stores session hashes, encrypts Kakao credentials and isolates users", async () => {
    const a = await login("isolation-a"),
      b = await login("isolation-b");
    await seed(a.token);
    const response = await call("/api/snapshot", b.token);
    assert.equal((await response.json()).snapshot, null);
    const sessions = await pool.query(
      "SELECT token_hash FROM browser_sessions WHERE kakao_user_id=$1",
      [a.user.id],
    );
    assert.notEqual(sessions.rows[0].token_hash, a.token);
    const tokens = await pool.query(
      "SELECT access_token,refresh_token FROM kakao_tokens WHERE kakao_user_id=$1",
      [a.user.id],
    );
    assert.match(tokens.rows[0].access_token, /^enc:v1:/);
    assert.equal(
      credentialVault(secret).decrypt(tokens.rows[0].access_token),
      "mock-access-token",
    );
  });
  it("preserves notes across whole-snapshot and per-list imports, including explicit clearing", async () => {
    const a = await login("notes");
    await seed(a.token);
    assert.equal(
      (
        await call("/api/snapshot/item-note", a.token, "PATCH", {
          listId: "list-1",
          itemId: "one",
          localNote: "Private note",
        })
      ).status,
      200,
    );
    await seed(a.token);
    let r = await call("/api/snapshot/list", a.token, "PUT", {
      deviceId: "test",
      list: list(),
      syncedAt: at,
      source: "test-import",
      expectedListIds: ["list-1"],
    });
    assert.equal(r.status, 200);
    assert.equal(
      (await r.json()).snapshot.lists[0].items[0].localNote,
      "Private note",
    );
    r = await call("/api/snapshot/item-note", a.token, "PATCH", {
      listId: "list-1",
      itemId: "one",
      localNote: "",
    });
    assert.equal(
      (await r.json()).snapshot.lists[0].items[0].localNote,
      undefined,
    );
  });
  it("keeps unrelated concurrent note changes", async () => {
    const a = await login("concurrent-notes");
    await seed(a.token);
    const results = await Promise.all(
      ["one", "two"].map((itemId) =>
        call("/api/snapshot/item-note", a.token, "PATCH", {
          listId: "list-1",
          itemId,
          localNote: itemId,
        }),
      ),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      [200, 200],
    );
    const result = await (await call("/api/snapshot", a.token)).json();
    assert.deepEqual(
      result.snapshot.lists[0].items.map((item) => item.localNote),
      ["one", "two"],
    );
    assert.equal(result.serverVersion, 3);
  });
  it("serializes concurrent first writes and retains distinct lists", async () => {
    const a = await login("concurrent-first");
    const replies = await Promise.all(
      ["first", "second"].map((id) =>
        call("/api/snapshot/list", a.token, "PUT", {
          deviceId: "test",
          list: list(id),
          syncedAt: at,
          source: "test-import",
        }),
      ),
    );
    assert.deepEqual(
      replies.map((r) => r.status),
      [200, 200],
    );
    const result = await (await call("/api/snapshot", a.token)).json();
    assert.equal(result.snapshot.lists.length, 2);
    assert.equal(result.serverVersion, 2);
  });
  it("rejects malformed nested data without corrupting saved data", async () => {
    const a = await login("validation");
    await seed(a.token);
    for (const lists of [
      [null],
      [{ ...list(), items: null }],
      [
        {
          ...list(),
          items: [{ id: "x", title: "X", href: "javascript:alert(1)" }],
        },
      ],
    ]) {
      assert.equal(
        (
          await call("/api/snapshot", a.token, "PUT", {
            deviceId: "test",
            snapshot: { ...snapshot(), lists },
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (await (await call("/api/snapshot", a.token)).json()).snapshot.lists[0]
        .name,
      "list-1",
    );
  });
  it("disables demo sync without modifying lists", async () => {
    const a = await login("demo");
    await seed(a.token);
    assert.equal((await call("/api/sync/kakao", a.token, "POST")).status, 410);
    assert.equal(
      (await (await call("/api/snapshot", a.token)).json()).serverVersion,
      1,
    );
  });
  it("revokes a copied session while keeping other devices signed in", async () => {
    const a = await login("logout"),
      b = await login("logout");
    assert.equal((await call("/api/auth/logout", a.token, "POST")).status, 204);
    assert.equal((await call("/api/snapshot", a.token)).status, 401);
    assert.equal((await call("/api/snapshot", b.token)).status, 200);
    assert.equal(
      (await call("/api/auth/logout-all", b.token, "POST")).status,
      204,
    );
    assert.equal((await call("/api/snapshot", b.token)).status, 401);
  });
  it("deletes only the authenticated account and its assistant tokens", async () => {
    const a = await login("delete-a"),
      b = await login("delete-b");
    await seed(a.token);
    await seed(b.token);
    const key = await call("/api/agent-tokens", a.token, "POST", {
      name: "delete-key",
    });
    assert.equal(key.status, 201);
    assert.equal((await call("/api/account", a.token, "DELETE")).status, 204);
    for (const table of [
      "browser_sessions",
      "kakao_tokens",
      "agent_tokens",
      "snapshot_history",
      "latest_snapshots",
    ]) {
      assert.equal(
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM ${table} WHERE kakao_user_id=$1`,
              [a.user.id],
            )
          ).rows[0].count,
        ),
        0,
      );
    }
    assert.equal((await call("/api/snapshot", a.token)).status, 401);
    assert.equal((await call("/api/snapshot", b.token)).status, 200);
  });
  it("does not let a pre-deletion key request recreate access", async () => {
    const a = await login("delete-race");
    const started = new Date(Date.now() - 1000);
    await call("/api/account", a.token, "DELETE");
    await assert.rejects(
      issueAgentToken(
        createPostgresAgentTokenStore(pool),
        { kakaoUserId: a.user.id, name: "stale request", expiresInDays: 30 },
        () => started,
      ),
      AgentTokenLimitError,
    );
  });
  it("does not copy the full snapshot into history for every import chunk", async () => {
    const a = await login("history");
    for (const [index, id] of ["a", "b", "c"].entries()) {
      const result = await call("/api/snapshot/list", a.token, "PUT", {
        deviceId: "test",
        list: list(id),
        syncedAt: at,
        source: "test-import",
        ...(index === 2 ? { expectedListIds: ["a", "b", "c"] } : {}),
      });
      assert.equal(result.status, 200);
    }
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM snapshot_history WHERE kakao_user_id=$1",
            [a.user.id],
          )
        ).rows[0].count,
      ),
      1,
    );
  });
  it("rejects compressed bodies before decoding", async () => {
    const response = await fetch(`${base}/api/auth/mock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: "not-compressed",
    });
    assert.equal(response.status, 415);
    assert.match(
      await response.text(),
      /Compressed request bodies are not accepted/,
    );
  });
  it("rejects unreasonable forwarded IP headers before rate-limit parsing", async () => {
    const response = await fetch(`${base}/api/auth/mock`, {
      method: "POST",
      headers: { "x-forwarded-for": `::1%${"a".repeat(2000)}` },
    });
    assert.equal(response.status, 400);
  });
  it("returns stable public errors without internal payloads", async () => {
    const response = await call("/api/snapshot", "unknown");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      response.headers.get("content-type")?.includes("application/json"),
      true,
    );
    assert.equal(
      (await response.json()).error.message,
      "Your session has ended. Sign in again.",
    );
  });
  it("uses real HTTP code exchange and hides upstream failures", {
    skip: !process.env.KAKAO_SIMULATION_URL,
  }, async () => {
    let r = await call("/api/auth/kakao/exchange", undefined, "POST", {
      code: "user-1",
      redirectUri: "http://localhost/callback",
    });
    assert.equal(r.status, 200, await r.clone().text());
    const session = await r.json();
    assert.equal(session.user.id, "user-1");
    assert.equal((await call("/api/snapshot", session.token)).status, 200);
    r = await call("/api/auth/kakao/exchange", undefined, "POST", {
      code: "upstream-error",
      redirectUri: "http://localhost/callback",
    });
    assert.equal(r.status, 502);
    assert.equal((await r.text()).includes("internal_secret"), false);
  });
  it("terminates a hanging Kakao exchange within the request budget", {
    skip: !process.env.KAKAO_SIMULATION_URL,
  }, async () => {
    const start = Date.now();
    const response = await call("/api/auth/kakao/exchange", undefined, "POST", {
      code: "timeout",
      redirectUri: "http://localhost/callback",
    });
    assert.equal(response.status, 504);
    assert.ok(Date.now() - start < 8000);
  });
  it("bounds saved history and returns small intermediate receipts", async () => {
    const a = await login("retention");
    await seed(a.token);
    for (let i = 0; i < 24; i++) {
      const response = await call("/api/snapshot/item-note", a.token, "PATCH", {
        listId: "list-1",
        itemId: "one",
        localNote: String(i),
      });
      assert.equal(response.status, 200);
    }
    const count = await pool.query(
      "SELECT count(*) FROM snapshot_history WHERE kakao_user_id=$1",
      [a.user.id],
    );
    assert.equal(Number(count.rows[0].count), 20);
    const response = await call(
      "/api/snapshot/list?summary=true",
      a.token,
      "PUT",
      { deviceId: "test", list: list(), syncedAt: at, source: "import" },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).snapshot, undefined);
  });
  it("rejects missing JSON bodies with a client error", async () => {
    const a = await login("empty-body");
    for (const method of ["PUT", "PATCH"]) {
      const path =
        method === "PATCH" ? "/api/snapshot/item-note" : "/api/snapshot";
      assert.equal((await call(path, a.token, method)).status, 400);
    }
  });
  it("bounds authentication floods with a shared API limit", async () => {
    const responses = [];
    for (let i = 0; i < 35; i++)
      responses.push(
        await call("/api/auth/kakao/exchange", undefined, "POST", {}),
      );
    assert.equal(responses.at(-1)?.status, 429);
  });
});
