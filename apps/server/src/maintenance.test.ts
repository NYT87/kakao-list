import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import {
  createMaintenanceRouter,
  type MaintenanceResult,
} from "./maintenance.js";

const SECRET = "test-cron-secret-0123456789abcdef";
const RESULT: MaintenanceResult = {
  rateLimitBuckets: 3,
  pendingAuthorizations: 0,
  oauthTokens: 1,
  oauthGrants: 0,
  authorizationCodes: 2,
  oauthClients: 1,
  agentTokens: 0,
};

describe("maintenance cron endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let runs = 0;
  let fail = false;

  before(async () => {
    const app = express();
    app.use(
      "/api/cron/maintenance",
      createMaintenanceRouter({
        secret: SECRET,
        run: async () => {
          runs += 1;
          if (fail) {
            throw new Error("db password=hunter2 unreachable");
          }
          return RESULT;
        },
      }),
    );
    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  const call = (authorization?: string, method = "GET") =>
    fetch(`${baseUrl}/api/cron/maintenance`, {
      method,
      headers: authorization ? { Authorization: authorization } : {},
    });

  it("runs maintenance for the cron secret and reports what it deleted", async () => {
    const before = runs;
    const response = await call(`Bearer ${SECRET}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { deleted: RESULT });
    assert.equal(runs, before + 1);
  });

  it("rejects missing or wrong credentials without running", async () => {
    const before = runs;

    for (const authorization of [
      undefined,
      "Bearer wrong",
      `Bearer ${SECRET}x`,
      SECRET,
      `Basic ${SECRET}`,
    ]) {
      assert.equal((await call(authorization)).status, 401, authorization);
    }
    assert.equal(runs, before);
  });

  it("only answers GET", async () => {
    const response = await call(`Bearer ${SECRET}`, "POST");
    assert.equal(response.status, 405);
  });

  it("reports failures without internal details", async () => {
    fail = true;
    try {
      const response = await call(`Bearer ${SECRET}`);
      assert.equal(response.status, 500);
      assert.equal((await response.text()).includes("hunter2"), false);
    } finally {
      fail = false;
    }
  });

  it("refuses short secrets", () => {
    assert.throws(() =>
      createMaintenanceRouter({ secret: "short", run: async () => RESULT }),
    );
  });
});
