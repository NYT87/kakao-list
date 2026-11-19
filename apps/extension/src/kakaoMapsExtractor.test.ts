import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { extractSnapshotInPageEnvelope } from "./kakaoMapsExtractor.js";

const pages: Record<string, unknown> = {
  "/folder/list": [
    { folderid: 1, title: "Mine", status: "O" },
    {
      folderid: 2,
      title: "Followed",
      status: "O",
      subscribe: "Y",
      nickname: "친구",
    },
  ],
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
});
