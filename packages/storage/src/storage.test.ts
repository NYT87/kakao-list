import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LocalStorageFavoriteListsRepository } from "./index.js";

const snapshot = {
  syncedAt: "2026-10-25T00:00:00Z",
  source: "test",
  lists: [
    {
      id: "l",
      name: "Private",
      updatedAt: "2026-10-25T00:00:00Z",
      itemCount: 1,
      items: [{ id: "p", title: "Place", localNote: "Private note" }],
    },
  ],
};
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
describe("account cache", () => {
  it("isolates accounts and discards unidentified legacy data", async () => {
    const data = storage();
    data.setItem("cache", JSON.stringify(snapshot));
    const root = new LocalStorageFavoriteListsRepository("cache", data);
    const a = root.forAccount("a"),
      b = root.forAccount("b");
    assert.deepEqual(await a.loadLists(), []);
    await a.saveSnapshot(snapshot);
    assert.deepEqual(await b.loadLists(), []);
    assert.equal((await a.loadLists())[0].items[0].localNote, "Private note");
    a.clear();
    assert.deepEqual(await a.loadLists(), []);
  });
  it("recovers from corrupt JSON and malformed shapes", async () => {
    const data = storage(),
      repo = new LocalStorageFavoriteListsRepository("cache", data);
    for (const raw of ["{broken", '{"lists":[null]}']) {
      data.setItem("cache", raw);
      assert.deepEqual(await repo.loadLists(), []);
      assert.equal(await repo.getLastSyncedAt(), null);
      assert.equal(data.getItem("cache"), null);
    }
  });
  it("reports unavailable writes and recovers from blocked reads", async () => {
    const repo = new LocalStorageFavoriteListsRepository("cache", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    assert.deepEqual(await repo.loadLists(), []);
    await assert.rejects(repo.saveSnapshot(snapshot), /Could not save/);
  });
});
