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
  it("keeps raw Kakao coordinates, favourite type, subscribed and completeness", () => {
    const parsed = parseSnapshot({
      ...snapshot,
      complete: true,
      lists: [
        {
          ...snapshot.lists[0],
          subscribed: true,
          items: [
            {
              id: "p",
              title: "Place",
              kakaoX: 497278,
              kakaoY: 1128228,
              kakaoType: "PLACE",
            },
          ],
        },
      ],
    });
    assert.equal(parsed.complete, true);
    assert.equal(parsed.lists[0].subscribed, true);
    assert.deepEqual(
      [
        parsed.lists[0].items[0].kakaoX,
        parsed.lists[0].items[0].kakaoY,
        parsed.lists[0].items[0].kakaoType,
      ],
      [497278, 1128228, "PLACE"],
    );
  });
  it("keeps negative Kakao coordinates (southern Jeju, far western islands)", () => {
    for (const [kakaoX, kakaoY] of [
      [471350, -32433],
      [-9670, 1248026],
    ]) {
      const parsed = parseSnapshot({
        ...snapshot,
        lists: [
          {
            ...snapshot.lists[0],
            items: [{ id: "p", title: "Place", kakaoX, kakaoY }],
          },
        ],
      });
      const item = parsed.lists[0].items[0];
      assert.deepEqual([item.kakaoX, item.kakaoY], [kakaoX, kakaoY]);
    }
  });
  it("drops bad Kakao fields instead of refusing the snapshot", () => {
    for (const bad of [
      { kakaoX: "a", kakaoY: 3 },
      { kakaoX: 5, kakaoY: 0 },
      { kakaoX: 0, kakaoY: 0 },
      { kakaoX: 5, kakaoY: Number.NaN },
      { kakaoX: 5 },
      { kakaoType: "x".repeat(41) },
      { kakaoType: 7 },
    ]) {
      const parsed = parseSnapshot({
        ...snapshot,
        complete: "yes",
        lists: [
          {
            ...snapshot.lists[0],
            subscribed: "yes",
            items: [{ id: "p", title: "Place", ...bad }],
          },
        ],
      });
      const item = parsed.lists[0].items[0];
      assert.equal(item.id, "p");
      assert.equal(item.kakaoX, undefined);
      assert.equal(item.kakaoY, undefined);
      assert.equal(item.kakaoType, undefined);
      assert.equal(parsed.complete, undefined);
      assert.equal(parsed.lists[0].subscribed, undefined);
      assert.ok(!("kakaoX" in item) && !("complete" in parsed));
    }
  });
  it("still reads a snapshot stored before these fields existed", () => {
    const parsed = parseSnapshot(snapshot);
    assert.equal(parsed.complete, undefined);
    assert.equal(parsed.lists[0].subscribed, undefined);
    assert.equal(parsed.lists[0].items[0].kakaoX, undefined);
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
