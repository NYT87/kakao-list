import fs from "node:fs";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, "../.."), "");
  const extensionPublicKey = env.EXTENSION_PUBLIC_KEY?.trim();
  const syncServerPermission = toHostPermissionPattern(
    env.VITE_SYNC_SERVER_URL,
  );
  const debugMode = env.DEBUG_MODE === "true";

  return {
    envDir: "../..",
    define: {
      __DEBUG_MODE__: JSON.stringify(debugMode),
    },
    plugins: [
      react(),
      {
        name: "write-extension-manifest",
        closeBundle() {
          const sourceManifestPath = path.resolve(
            __dirname,
            "public/manifest.json",
          );
          const distManifestPath = path.resolve(
            __dirname,
            "dist/manifest.json",
          );
          const manifest = JSON.parse(
            fs.readFileSync(sourceManifestPath, "utf8"),
          ) as Record<string, unknown>;
          const hostPermissions = Array.isArray(manifest.host_permissions)
            ? [
                ...new Set([
                  ...manifest.host_permissions.map(String),
                  ...(syncServerPermission ? [syncServerPermission] : []),
                ]),
              ]
            : syncServerPermission
              ? [syncServerPermission]
              : [];

          if (extensionPublicKey) {
            manifest.key = extensionPublicKey;
          } else {
            delete manifest.key;
          }

          manifest.host_permissions = hostPermissions;

          fs.writeFileSync(
            distManifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
            "utf8",
          );
        },
      },
    ],
    build: {
      emptyOutDir: true,
      outDir: "dist",
      rollupOptions: {
        input: {
          popup: "popup.html",
          options: "options.html",
          background: "src/background.ts",
        },
        output: {
          entryFileNames: "assets/[name].js",
          chunkFileNames: "assets/[name].js",
          assetFileNames: "assets/[name].[ext]",
        },
      },
    },
  };
});

function toHostPermissionPattern(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}
