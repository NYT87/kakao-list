import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consumeOAuthAttempt, createOAuthAttempt } from "./index.js";

describe("browser-bound OAuth attempts", () => {
  const store = () => {
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
  };
  it("uses random state and consumes a valid attempt once", () => {
    const s = store(),
      state = createOAuthAttempt(s, 1000);
    assert.notEqual(state, createOAuthAttempt(store(), 1000));
    assert.equal(consumeOAuthAttempt(state, s, 2000), true);
    assert.equal(consumeOAuthAttempt(state, s, 2000), false);
  });
  it("rejects missing, foreign and expired state", () => {
    const s = store(),
      state = createOAuthAttempt(s, 1000);
    assert.equal(consumeOAuthAttempt(null, s, 2000), false);
    assert.equal(consumeOAuthAttempt("foreign", s, 2000), false);
    assert.equal(consumeOAuthAttempt(state, store(), 2000), false);
    assert.equal(consumeOAuthAttempt(state, s, 1000 + 600001), false);
  });
});
