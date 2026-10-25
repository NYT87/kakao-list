import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import type { Pool } from "pg";
import { createApplication } from "./app.js";

const servers: Server[] = [];
const packageVersion = (
  JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version: string;
  }
).version;
after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function requestHealth(query: () => Promise<unknown>) {
  const pool = { query } as unknown as Pool;
  const runtime = createApplication({
    pool,
    env: {
      SYNC_SERVER_SIGNING_SECRET: `test-only-secret-${"a".repeat(64)}`,
      BUILD_COMMIT_SHA: "ABCDEF1234567890",
    },
  });
  const server = await new Promise<Server>((resolve) => {
    const running = runtime.app.listen(0, "127.0.0.1", () => resolve(running));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return { response, body: await response.json() };
}

describe("health build identity", () => {
  it("includes the server version and commit when PostgreSQL responds", async () => {
    const { response, body } = await requestHealth(async () => ({ rows: [] }));
    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      service: "kakao-lists-sync-server",
      database: "postgres",
      version: packageVersion,
      commit: "abcde",
    });
  });

  it("keeps build identity available when PostgreSQL fails", async () => {
    const { response, body } = await requestHealth(async () => {
      throw new Error("Private database diagnostic");
    });
    assert.equal(response.status, 500);
    assert.deepEqual(body, {
      version: packageVersion,
      commit: "abcde",
      error: {
        code: "HTTP_500",
        message: "Something went wrong. Please try again.",
      },
    });
  });
});
