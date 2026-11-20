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

  // Real favourite (map.kakao.com, 2026-11-20): Kakao's own lat/lon for this x/y.
  it("converts a negative y (southern Jeju)", () => {
    const r = wcongnamulToLatLng(471350, -32433);
    assert.ok(r);
    assert.ok(Math.abs(r.lat - 33.37661909) < 1e-5, `lat ${r.lat}`);
    assert.ok(Math.abs(r.lng - 126.87684594) < 1e-5, `lng ${r.lng}`);
  });

  it("converts a negative x (far western islands)", () => {
    // Near Baengnyeongdo, about 37.97°N 124.68°E: west of the belt's false easting.
    const r = wcongnamulToLatLng(-9670, 1248026);
    assert.ok(r);
    assert.ok(
      r.lng > 124 && r.lng < 125 && r.lat > 37.5 && r.lat < 38.5,
      `${r.lat}, ${r.lng}`,
    );
  });

  it("returns undefined for missing, zero or non-numeric input", () => {
    const bad: [unknown, unknown][] = [
      [undefined, 1],
      [0, 0],
      [0, 1128228],
      [497278, 0],
      ["a", 3],
      [Number.NaN, 1],
      [Number.POSITIVE_INFINITY, 1],
    ];
    for (const [x, y] of bad) assert.equal(wcongnamulToLatLng(x, y), undefined);
  });

  it("returns undefined when the result falls outside 32–40°N, 123–133°E", () => {
    assert.equal(wcongnamulToLatLng(5_000_000, 5_000_000), undefined);
  });
});
