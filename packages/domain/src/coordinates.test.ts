import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OWNER_FIXTURES } from "./coordinates.fixtures.js";
import { wcongnamulToLatLng } from "./coordinates.js";

describe("wcongnamulToLatLng", () => {
  // Published pair: WGS84 (126.9876757, 37.5611523) ↔ WCONGNAMUL (497278, 1128228)
  it("converts the published reference point within ~1 m", () => {
    const r = wcongnamulToLatLng(497278, 1128228);
    assert.ok(r);
    assert.ok(Math.abs(r.lat - 37.5611523) < 1e-5, `lat ${r.lat}`);
    assert.ok(Math.abs(r.lng - 126.9876757) < 1e-5, `lng ${r.lng}`);
  });

  it("matches the owner's Kakao SDK fixtures (G1)", {
    skip: OWNER_FIXTURES.length === 0,
  }, () => {
    for (const f of OWNER_FIXTURES) {
      const r = wcongnamulToLatLng(f.x, f.y);
      assert.ok(r, f.place);
      assert.ok(Math.abs(r.lat - f.lat) < 1e-5, `${f.place} lat ${r.lat}`);
      assert.ok(Math.abs(r.lng - f.lng) < 1e-5, `${f.place} lng ${r.lng}`);
    }
  });

  it("returns undefined for missing, zero, negative or non-numeric input", () => {
    const bad: [unknown, unknown][] = [
      [undefined, 1],
      [0, 0],
      [-5, 3],
      ["a", 3],
      [Number.NaN, 1],
    ];
    for (const [x, y] of bad) assert.equal(wcongnamulToLatLng(x, y), undefined);
  });

  it("returns undefined when the result falls outside 32–40°N, 123–133°E", () => {
    assert.equal(wcongnamulToLatLng(5_000_000, 5_000_000), undefined);
  });
});
