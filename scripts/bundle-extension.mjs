import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const extensionDir = path.join(repoRoot, "apps", "extension");
const zipPath = path.join(extensionDir, "kakao-lists-extension.zip");

execFileSync("pnpm", ["--filter", "@kakao-lists/extension", "build"], {
  cwd: repoRoot,
  stdio: "inherit"
});

fs.rmSync(zipPath, { force: true });

execFileSync("zip", ["-r", path.basename(zipPath), "dist"], {
  cwd: extensionDir,
  stdio: "inherit"
});

console.info(`Created extension bundle at ${zipPath}`);
