import assert from "node:assert/strict";
import { it } from "node:test";
import { HttpCloudSyncClient } from "./index.js";

it("turns unreachable connections into plain recovery messages", async () => {
  await assert.rejects(
    new HttpCloudSyncClient(
      "http://127.0.0.1:1",
      undefined,
      100,
    ).pullLatestSnapshot(),
    /Could not connect/,
  );
});
