import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRoute } from "./routes.js";

describe("deep link recovery", () => {
  it("returns to overview for malformed list encoding", () => {
    assert.equal(parseRoute("#list/%").view, "overview");
  });
  it("decodes ids once and retains literal percent signs", () => {
    assert.deepEqual(parseRoute("#list/list%25?item=item%2525"), {
      view: "list",
      listId: "list%",
      itemId: "item%25",
    });
  });
});
