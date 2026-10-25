import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createApplication } from "./app.js";

loadRootEnvFiles();
const runtime = createApplication({ env: process.env });
export default runtime.app;
export const ensureServerReady = runtime.ensureServerReady;
const direct =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  await runtime.ensureServerReady();
  runtime.app.listen(
    Number(process.env.PORT ?? process.env.SYNC_SERVER_PORT ?? 8787),
    () => console.info("Kakao Lists server started."),
  );
  setInterval(() => {
    void runtime.maintain().catch(() => console.error("Maintenance failed."));
  }, 3600000).unref();
}

function loadRootEnvFiles() {
  const currentFile = fileURLToPath(import.meta.url);
  const rootDir = path.resolve(path.dirname(currentFile), "../../..");

  for (const name of [".env", ".env.local"]) {
    loadEnvFile(path.join(rootDir, name));
  }
}

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || key in process.env) {
      continue;
    }

    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    process.env[key] = value;
  }
}
