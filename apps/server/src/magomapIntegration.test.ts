import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PushSnapshotResult, SyncSnapshot } from "@kakao-lists/domain";
import { toMagomapItems, toMagomapLists } from "./magomapIntegration.js";

const at = "2026-10-25T00:00:00.000Z";
const stored = (snapshot: Partial<SyncSnapshot>): PushSnapshotResult => ({
  userId: "4242",
  deviceId: "d",
  serverVersion: 3,
  receivedAt: "2026-11-01T10:00:00.000Z",
  snapshot: { syncedAt: at, source: "test", lists: [], ...snapshot },
});

const current = stored({
  complete: true,
  lists: [
    {
      id: "kakao-folder-123",
      name: "제주",
      description: "가고 싶은 곳",
      creatorName: "지은",
      updatedAt: at,
      itemCount: 3,
      subscribed: false,
      items: [
        {
          id: "9001",
          title: "바다정원",
          placeKey: "777",
          subtitle: "제주 애월읍",
          color: "03",
          kakaoNote: "뷰",
          localNote: "다시 가기",
          kakaoX: 497278,
          kakaoY: 1128228,
          kakaoType: "PLACE",
        },
        {
          id: "9002",
          title: "집",
          placeKey: "888",
          kakaoType: "ADDRESS",
          kakaoX: -1,
        },
        { id: "9003", title: "옛 기록", placeKey: "999" },
      ],
    },
    {
      id: "kakao-folder-55",
      name: "친구 목록",
      creatorName: "친구",
      updatedAt: at,
      itemCount: 0,
      subscribed: true,
      items: [],
    },
    {
      id: "local-list",
      name: "skip me",
      updatedAt: at,
      itemCount: 0,
      items: [],
    },
  ],
});

describe("magomap lists", () => {
  it("summarises the stored snapshot in contract v1", () => {
    const body = toMagomapLists("4242", current);
    assert.deepEqual(body, {
      contractVersion: 1,
      kakaoUserId: "4242",
      importedAt: "2026-11-01T10:00:00.000Z",
      complete: true,
      subscriptionKnown: false,
      // 제주 is the account's own list, made by 지은.
      ownerNickname: "지은",
      lists: [
        {
          kakaoFolderId: 123,
          name: "제주",
          description: "가고 싶은 곳",
          subscribed: false,
          itemCount: 3,
        },
        {
          kakaoFolderId: 55,
          name: "친구 목록",
          subscribed: true,
          ownerName: "친구",
          itemCount: 0,
        },
      ],
    });
  });

  it("knows subscriptions only when every list says whether it is followed", () => {
    const known = stored({
      lists: current.snapshot.lists.filter((l) => l.id !== "local-list"),
    });
    assert.equal(toMagomapLists("4242", known).subscriptionKnown, true);
  });

  it("reads a snapshot stored before completeness, subscriptions and coordinates", () => {
    const old = stored({
      lists: [
        {
          id: "kakao-folder-1",
          name: "옛 목록",
          creatorName: "지은",
          updatedAt: at,
          itemCount: 1,
          items: [{ id: "1", title: "곳", placeKey: "5" }],
        },
      ],
    });
    const lists = toMagomapLists("4242", old);
    assert.equal(lists.complete, false);
    assert.equal(lists.subscriptionKnown, false);
    assert.equal(lists.lists[0]?.subscribed, false);
    assert.equal(lists.lists[0]?.ownerName, undefined);
    const items = toMagomapItems(old, 1, 0, 500);
    assert.ok(items);
    assert.equal("lat" in (items.items[0] ?? {}), false);
    assert.equal(items.items[0]?.placeKey, "5");
  });
});

const own = (name: string, creatorName?: string) => ({
  id: `kakao-folder-${name.length + 1}${name.charCodeAt(0)}`,
  name,
  ...(creatorName !== undefined ? { creatorName } : {}),
  updatedAt: at,
  itemCount: 0,
  subscribed: false,
  items: [],
});

describe("magomap lists: the account's own nickname", () => {
  it("sends the nickname from the account's own lists", () => {
    const body = toMagomapLists(
      "4242",
      stored({ lists: [own("제주", "  지은 ")] }),
    );
    assert.equal(body.ownerNickname, "지은");
  });

  it("skips own lists without a name and uses the next one", () => {
    const body = toMagomapLists(
      "4242",
      stored({ lists: [own("비밀", ""), own("부산", "지은")] }),
    );
    assert.equal(body.ownerNickname, "지은");
  });

  it("never takes the nickname of a followed list's creator", () => {
    const body = toMagomapLists(
      "4242",
      stored({
        lists: [{ ...own("친구", "Other"), subscribed: true }, own("비밀")],
      }),
    );
    assert.ok(!("ownerNickname" in body));
  });

  it("leaves it out when no list has a name", () => {
    const body = toMagomapLists(
      "4242",
      stored({ lists: [own("비밀"), own("집", "  ")] }),
    );
    assert.ok(!("ownerNickname" in body));
    assert.ok(!JSON.stringify(body).includes("ownerNickname"));
  });
});

describe("magomap items", () => {
  it("maps one page of a list's favourites", () => {
    const page = toMagomapItems(current, 123, 0, 500);
    assert.ok(page);
    assert.equal(page.contractVersion, 1);
    assert.equal(page.kakaoFolderId, 123);
    assert.equal(page.importedAt, "2026-11-01T10:00:00.000Z");
    assert.equal(page.total, 3);
    assert.equal(page.offset, 0);
    const [first, second, third] = page.items;
    assert.equal(first?.favoriteSeq, "9001");
    assert.equal(first?.favoriteType, "PLACE");
    assert.equal(first?.placeKey, "777");
    assert.equal(first?.title, "바다정원");
    assert.equal(first?.address, "제주 애월읍");
    assert.equal(first?.kakaoColor, "03");
    assert.equal(first?.kakaoNote, "뷰");
    assert.equal(first?.localNote, "다시 가기");
    assert.equal(first?.position, 0);
    assert.ok(Math.abs((first?.lat ?? 0) - 37.5611523) < 1e-5);
    assert.ok(Math.abs((first?.lng ?? 0) - 126.9876757) < 1e-5);
    assert.equal("lat" in (second ?? {}), false);
    assert.equal("lng" in (second ?? {}), false);
    assert.equal(third?.position, 2);
    assert.equal("favoriteType" in (third ?? {}), false);
  });

  it("emits placeKey only for place types once they are known, and for untyped favourites", () => {
    const page = toMagomapItems(current, 123, 0, 500, new Set(["PLACE"]));
    assert.deepEqual(
      page?.items.map((i) => i.placeKey),
      ["777", undefined, "999"],
    );
  });

  it("pages by offset and limit, keeping each favourite's place in the whole list", () => {
    const page = toMagomapItems(current, 123, 1, 1);
    assert.equal(page?.total, 3);
    assert.equal(page?.offset, 1);
    assert.deepEqual(
      page?.items.map((i) => [i.favoriteSeq, i.position]),
      [["9002", 1]],
    );
    assert.deepEqual(toMagomapItems(current, 123, 3, 500)?.items, []);
  });

  it("finds no list for an unknown folder", () => {
    assert.equal(toMagomapItems(current, 999, 0, 500), undefined);
  });
});
