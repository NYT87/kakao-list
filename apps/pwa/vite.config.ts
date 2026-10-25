import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { readBuildInfo } from "../../scripts/build-info.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");
  const buildInfo = readBuildInfo("apps/pwa");

  return {
    envDir: "../..",
    define: {
      __DEBUG_MODE__: JSON.stringify(env.DEBUG_MODE === "true"),
      __APP_VERSION__: JSON.stringify(buildInfo.version),
      __COMMIT_ID__: JSON.stringify(buildInfo.commit),
    },
    plugins: [
      react(),
      {
        name: "versioned-offline-shell",
        closeBundle() {
          const output = path.resolve(import.meta.dirname, "dist");
          const assets = fs
            .readdirSync(path.join(output, "assets"))
            .filter((name) => /\.(js|css)$/.test(name))
            .map((name) => `/assets/${name}`);
          const html = fs.readFileSync(path.join(output, "index.html"), "utf8");
          const version = crypto
            .createHash("sha256")
            .update(html + assets.join("|"))
            .digest("hex")
            .slice(0, 16);
          const worker = fs
            .readFileSync(
              path.resolve(import.meta.dirname, "public/sw.js"),
              "utf8",
            )
            .replace('"__SHELL_VERSION__"', JSON.stringify(version))
            .replace(
              '["__SHELL_ASSETS__"]',
              JSON.stringify([
                "/",
                "/index.html",
                "/icon-192.png",
                "/icon-512.png",
                "/manifest.webmanifest",
                ...assets,
              ]),
            );
          fs.writeFileSync(path.join(output, "sw.js"), worker);
        },
      },
    ],
  };
});
