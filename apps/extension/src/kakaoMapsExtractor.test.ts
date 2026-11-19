import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { extractSnapshotInPageEnvelope } from "./kakaoMapsExtractor.js";

const pages: Record<string, unknown> = {
  "/folder/list": [
    { folderid: 1, title: "Mine", status: "O", kakao_map_user_id: "me" },
    {
      folderid: 2,
      title: "Followed",
      status: "O",
      subscribe: "Y",
      nickname: "친구",
      kakao_map_user_id: "friend",
    },
    // Her own public list: Kakao marks public folders with subscribe too.
    {
      folderid: 3,
      title: "My public",
      status: "O",
      subscribe: "Y",
      kakao_map_user_id: "me",
    },
    {
      folderid: 4,
      title: "Flag off",
      status: "O",
      subscribe: "N",
      kakao_map_user_id: "x",
    },
    {
      folderid: 5,
      title: "Zero",
      status: "O",
      subscribe: 0,
      kakao_map_user_id: "y",
    },
  ],
  "/favorite/mine/list?folderid=3": { favorites: [] },
  "/favorite/mine/list?folderid=4": { favorites: [] },
  "/favorite/mine/list?folderid=5": { favorites: [] },
  "/favorite/mine/list?folderid=1": {
    favorites: [
      {
        seq: 11,
        type: "PLACE",
        display1: "Cafe",
        key: "123",
        x: 497278,
        y: 1128228,
        folderid: 1,
      },
    ],
  },
  "/favorite/mine/list?folderid=2": {
    favorites: [
      {
        seq: 21,
        type: "ADDRESS",
        display1: "Home",
        x: 500000,
        y: 1100000,
        folderid: 2,
      },
    ],
  },
};

const globals = globalThis as unknown as {
  window?: unknown;
  fetch: typeof fetch;
};
const realFetch = globals.fetch;
before(() => {
  globals.window = {
    location: {
      origin: "https://map.kakao.com",
      href: "https://map.kakao.com/",
    },
  };
  globals.fetch = (async (url: string) => {
    const u = new URL(url);
    const body = pages[u.pathname + u.search];
    return new Response(JSON.stringify(body ?? {}), {
      status: body ? 200 : 404,
    });
  }) as typeof fetch;
});
after(() => {
  globals.fetch = realFetch;
  delete globals.window;
});

describe("Kakao Maps page extraction", () => {
  it("copies raw coordinates, favourite type and the subscribed flag", async () => {
    const envelope = await extractSnapshotInPageEnvelope();
    assert.ok(envelope.ok, envelope.error);
    const lists = envelope.result?.snapshot.lists ?? [];
    const mine = lists.find((l) => l.id === "kakao-folder-1");
    const followed = lists.find((l) => l.id === "kakao-folder-2");
    assert.equal(mine?.subscribed, false);
    assert.equal(followed?.subscribed, true);
    const item = mine?.items[0];
    assert.deepEqual(
      [item?.kakaoX, item?.kakaoY, item?.kakaoType],
      [497278, 1128228, "PLACE"],
    );
    assert.equal(followed?.items[0]?.kakaoType, "ADDRESS");
  });

  it("never counts her own public lists, or a flag that says no, as followed", async () => {
    const envelope = await extractSnapshotInPageEnvelope();
    assert.ok(envelope.ok, envelope.error);
    const subscribed = Object.fromEntries(
      (envelope.result?.snapshot.lists ?? []).map((l) => [l.id, l.subscribed]),
    );
    assert.equal(subscribed["kakao-folder-3"], false);
    assert.equal(subscribed["kakao-folder-4"], false);
    assert.equal(subscribed["kakao-folder-5"], false);
  });
});
