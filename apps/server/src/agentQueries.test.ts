import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FavoriteList, SyncSnapshot } from "@kakao-lists/domain";
import {
  findPlace,
  getListPage,
  LIST_PAGE_MAX_LIMIT,
  SEARCH_MAX_LIMIT,
  searchPlaces,
  summarizeLists,
} from "./agentQueries.js";

function buildList(
  id: string,
  name: string,
  items: FavoriteList["items"],
): FavoriteList {
  return {
    id,
    name,
    description: `${name} description`,
    updatedAt: "2026-10-01T00:00:00.000Z",
    itemCount: items.length,
    items,
  };
}

const snapshot: SyncSnapshot = {
  syncedAt: "2026-10-20T09:00:00.000Z",
  source: "test",
  lists: [
    buildList("busan", "Busan trip", [
      {
        id: "1",
        title: "Momos Coffee",
        subtitle: "Busan Geumjeong-gu",
        kakaoNote: "Best latte",
        href: "https://place.map.kakao.com/1",
        color: "01",
        kakaoFolderId: 7,
        placeKey: "1",
      },
      {
        id: "2",
        title: "Haeundae Beach",
        subtitle: "Busan Haeundae-gu",
        localNote: "Go at sunset",
      },
    ]),
    buildList("seoul", "서울 카페", [
      {
        id: "3",
        title: "어니언 성수",
        subtitle: "서울 성동구",
        kakaoNote: "빵 맛집",
      },
      { id: "4", title: "Café Onion Anguk", subtitle: "Seoul Jongno-gu" },
    ]),
  ],
};

describe("summarizeLists", () => {
  it("returns list metadata without items and counts actual places", () => {
    const result = summarizeLists(snapshot);

    assert.equal(result.syncedAt, snapshot.syncedAt);
    assert.deepEqual(result.lists, [
      {
        id: "busan",
        name: "Busan trip",
        description: "Busan trip description",
        updatedAt: "2026-10-01T00:00:00.000Z",
        placeCount: 2,
      },
      {
        id: "seoul",
        name: "서울 카페",
        description: "서울 카페 description",
        updatedAt: "2026-10-01T00:00:00.000Z",
        placeCount: 2,
      },
    ]);
  });

  it("returns an empty result when the user has no snapshot", () => {
    assert.deepEqual(summarizeLists(null), { syncedAt: null, lists: [] });
  });
});

describe("getListPage", () => {
  it("returns places with list context and only agent-facing fields", () => {
    const page = getListPage(snapshot, "busan", {});

    assert.ok(page);
    assert.equal(page.list.name, "Busan trip");
    assert.equal(page.total, 2);
    assert.equal(page.nextOffset, null);
    assert.deepEqual(page.places[0], {
      listId: "busan",
      listName: "Busan trip",
      id: "1",
      title: "Momos Coffee",
      subtitle: "Busan Geumjeong-gu",
      kakaoNote: "Best latte",
      url: "https://place.map.kakao.com/1",
    });
  });

  it("paginates with offset and limit and reports the next offset", () => {
    const first = getListPage(snapshot, "busan", { limit: 1 });
    const second = getListPage(snapshot, "busan", { limit: 1, offset: 1 });

    assert.deepEqual(
      first?.places.map((place) => place.id),
      ["1"],
    );
    assert.equal(first?.nextOffset, 1);
    assert.deepEqual(
      second?.places.map((place) => place.id),
      ["2"],
    );
    assert.equal(second?.nextOffset, null);
  });

  it("clamps out-of-range pagination values", () => {
    const page = getListPage(snapshot, "busan", {
      limit: LIST_PAGE_MAX_LIMIT + 1000,
      offset: -5,
    });

    assert.equal(page?.limit, LIST_PAGE_MAX_LIMIT);
    assert.equal(page?.offset, 0);
    assert.equal(page?.places.length, 2);
  });

  it("returns an empty page when the offset is past the end", () => {
    const page = getListPage(snapshot, "busan", { offset: 10 });

    assert.deepEqual(page?.places, []);
    assert.equal(page?.nextOffset, null);
  });

  it("returns null for an unknown list or a missing snapshot", () => {
    assert.equal(getListPage(snapshot, "missing", {}), null);
    assert.equal(getListPage(null, "busan", {}), null);
  });
});

describe("searchPlaces", () => {
  const table: Array<{ name: string; query: string; expected: string[] }> = [
    { name: "matches title", query: "momos", expected: ["1"] },
    { name: "matches subtitle", query: "haeundae-gu", expected: ["2"] },
    { name: "matches Kakao note", query: "LATTE", expected: ["1"] },
    { name: "matches local note", query: "sunset", expected: ["2"] },
    { name: "matches Korean text", query: "성수", expected: ["3"] },
    { name: "requires every term", query: "busan beach", expected: ["2"] },
    { name: "ignores accents", query: "cafe onion", expected: ["4"] },
    { name: "returns nothing without a match", query: "tokyo", expected: [] },
  ];

  for (const { name, query, expected } of table) {
    it(name, () => {
      const result = searchPlaces(snapshot, { query });

      assert.deepEqual(
        result.places.map((place) => place.id),
        expected,
      );
      assert.equal(result.total, expected.length);
    });
  }

  it("restricts the search to one list", () => {
    const result = searchPlaces(snapshot, { query: "onion", listId: "busan" });

    assert.deepEqual(result.places, []);
  });

  it("limits results but still reports the total", () => {
    const result = searchPlaces(snapshot, { query: "busan", limit: 1 });

    assert.equal(result.places.length, 1);
    assert.equal(result.total, 2);
  });

  it("clamps the limit to the maximum", () => {
    const result = searchPlaces(snapshot, {
      query: "busan",
      limit: SEARCH_MAX_LIMIT + 1,
    });

    assert.equal(result.limit, SEARCH_MAX_LIMIT);
  });

  it("returns nothing for a blank query", () => {
    assert.equal(searchPlaces(snapshot, { query: "   " }).total, 0);
  });

  it("returns nothing when the user has no snapshot", () => {
    assert.deepEqual(searchPlaces(null, { query: "busan" }), {
      syncedAt: null,
      total: 0,
      limit: 20,
      places: [],
    });
  });
});

describe("findPlace", () => {
  it("returns the place with its list context", () => {
    assert.deepEqual(findPlace(snapshot, "seoul", "3"), {
      listId: "seoul",
      listName: "서울 카페",
      id: "3",
      title: "어니언 성수",
      subtitle: "서울 성동구",
      kakaoNote: "빵 맛집",
    });
  });

  it("returns null when the place is in a different list or missing", () => {
    assert.equal(findPlace(snapshot, "busan", "3"), null);
    assert.equal(findPlace(snapshot, "busan", "99"), null);
    assert.equal(findPlace(null, "busan", "1"), null);
  });
});
