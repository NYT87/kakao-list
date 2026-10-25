import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";

function luminance(hex: string) {
  const c = [0, 2, 4]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
it("keeps semantic text and focus tokens readable in both themes and clients", () => {
  for (const app of ["pwa", "extension"]) {
    const css = fs.readFileSync(
      new URL(`../../${app}/src/styles.css`, import.meta.url),
      "utf8",
    );
    for (const theme of ["light", "dark"]) {
      const start = css.indexOf(`:root[data-theme="${theme}"]`);
      const block = css.slice(start, css.indexOf("}", start));
      const tokens = Object.fromEntries(
        [...block.matchAll(/--([a-z-]+):\s*#([a-f0-9]{6})/g)].map((match) => [
          match[1],
          match[2],
        ]),
      );
      for (const surface of ["bg", "panel"]) {
        for (const role of [
          "text",
          "muted",
          "primary",
          ...(app === "pwa" ? ["primary-strong", "error"] : []),
        ])
          assert.ok(
            contrast(tokens[role], tokens[surface]) >= 4.5,
            `${app} ${theme} ${role} on ${surface}`,
          );
        assert.ok(
          contrast(tokens["focus-ring"], tokens[surface]) >= 3,
          `${app} ${theme} focus`,
        );
      }
    }
  }
});
