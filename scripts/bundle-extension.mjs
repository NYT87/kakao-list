import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const extensionDir = path.join(repoRoot, "apps", "extension");
const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionDir, "public", "manifest.json"), "utf8"),
);
const extensionPackage = JSON.parse(
  fs.readFileSync(path.join(extensionDir, "package.json"), "utf8"),
);
const version = manifest.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
  throw new Error(
    "The extension manifest needs a numeric version before bundling.",
  );
}
if (version !== extensionPackage.version) {
  throw new Error(
    `Extension manifest version ${version} does not match package version ${extensionPackage.version}.`,
  );
}
const commit = execFileSync("git", ["rev-parse", "--short=5", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
if (
  execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim()
) {
  console.warn(
    "The working tree has uncommitted changes; the filename's commit ID identifies HEAD only.",
  );
}
const zipName = `kakao-lists-extension-${version}-${commit}.zip`;
const zipPath = path.join(extensionDir, zipName);

execFileSync("pnpm", ["--filter", "@kakao-lists/extension", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});

fs.rmSync(zipPath, { force: true });

execFileSync("zip", ["-r", path.basename(zipPath), "dist"], {
  cwd: extensionDir,
  stdio: "inherit",
});

console.info(`Created extension bundle at ${zipPath}`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `path=apps/extension/${zipName}\nfilename=${zipName}\n`,
  );
}
