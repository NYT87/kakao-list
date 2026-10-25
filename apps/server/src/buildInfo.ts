import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export function getBuildInfo(env: NodeJS.ProcessEnv) {
  const suppliedSha = [
    env.BUILD_COMMIT_SHA,
    env.VERCEL_GIT_COMMIT_SHA,
    env.GITHUB_SHA,
  ].find(
    (value) => typeof value === "string" && /^[a-f\d]{5,40}$/i.test(value),
  );
  let commit = suppliedSha?.slice(0, 5).toLowerCase();
  if (!commit) {
    try {
      commit = execFileSync("git", ["rev-parse", "--short=5", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      commit = "unknown";
    }
  }

  return { version: packageJson.version, commit };
}
