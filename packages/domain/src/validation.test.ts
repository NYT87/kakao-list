import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSnapshot, reconcileDrafts } from "./index.js";

const snapshot = {
  syncedAt: "2026-10-25T00:00:00Z",
  source: "test",
  lists: [
    {
      id: "l",
      name: "List",
      updatedAt: "2026-10-25T00:00:00Z",
      itemCount: 1,
      items: [
        { id: "p", title: "Place", href: "https://place.map.kakao.com/1" },
      ],
    },
  ],
};
describe("snapshot boundary", () => {
  it("preserves valid data and normalizes known fields", () => {
    assert.equal(parseSnapshot(snapshot).lists[0].items[0].id, "p");
  });
  it("rejects malformed nested data, unsafe links and duplicate ids", () => {
    const bad: unknown[] = [
      { ...snapshot, lists: [null] },
      { ...snapshot, lists: [{ ...snapshot.lists[0], items: null }] },
      {
        ...snapshot,
        lists: [
          {
            ...snapshot.lists[0],
            items: [{ id: "p", title: "Place", href: "javascript:alert(1)" }],
          },
        ],
      },
      { ...snapshot, lists: [...snapshot.lists, ...snapshot.lists] },
      { ...snapshot, lists: [{ ...snapshot.lists[0], itemCount: 2 }] },
      { ...snapshot, syncedAt: "broken" },
      {
        ...snapshot,
        lists: [
          {
            ...snapshot.lists[0],
            items: [{ id: "p", title: "Place", localNote: "x".repeat(501) }],
          },
        ],
      },
    ];
    for (const value of bad) assert.throws(() => parseSnapshot(value));
  });
  it("refreshes clean fields without resetting dirty drafts", () => {
    assert.deepEqual(
      reconcileDrafts(
        { a: "draft", b: "old" },
        { a: "old", b: "old" },
        { a: "server", b: "new" },
      ),
      { a: "draft", b: "new" },
    );
  });
});
