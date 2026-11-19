import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FavoriteList, SyncSnapshot } from "@kakao-lists/domain";
import { mergeSnapshotList, preserveLocalNotes } from "./snapshots.js";

const at = "2026-10-25T00:00:00.000Z";
const list = (id: string): FavoriteList => ({
  id,
  name: id,
  updatedAt: at,
  itemCount: 1,
  items: [{ id: `${id}-1`, title: "One" }],
});

describe("snapshot completeness", () => {
  it("marks a list-by-list import complete only when the last chunk names every list", () => {
    const partial = mergeSnapshotList({
      currentSnapshot: null,
      list: list("a"),
      syncedAt: at,
      source: "test",
    });
    assert.equal(partial.complete, false);
    const last = mergeSnapshotList({
      currentSnapshot: partial,
      list: list("b"),
      syncedAt: at,
      source: "test",
      expectedListIds: ["a", "b"],
    });
    assert.equal(last.complete, true);
  });

  it("keeps the incoming completeness when carrying local notes over", () => {
    const incoming: SyncSnapshot = {
      syncedAt: at,
      source: "test",
      complete: true,
      lists: [list("a")],
    };
    assert.equal(preserveLocalNotes(null, incoming).complete, true);
    assert.equal(
      preserveLocalNotes(incoming, { ...incoming, complete: false }).complete,
      false,
    );
  });
});
