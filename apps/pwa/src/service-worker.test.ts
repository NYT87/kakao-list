import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";
import vm from "node:vm";

function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const cached: string[] = [];
  const context = {
    URL,
    Set,
    Promise,
    self: {
      location: { origin: "https://lists.test" },
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        handlers.set(name, handler),
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
    },
    caches: {
      open: async () => ({
        addAll: async (paths: string[]) => {
          cached.push(...paths);
        },
        match: async () => new Response("offline-shell"),
      }),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => {
      throw new Error("offline");
    },
  };
  const source = fs
    .readFileSync(new URL("../public/sw.js", import.meta.url), "utf8")
    .replace('["__SHELL_ASSETS__"]', '["/","/index.html","/assets/app.js"]');
  vm.runInNewContext(source, context);
  return { handlers, cached };
}
it("caches only the public shell and serves it for offline navigation", async () => {
  const w = worker();
  let install: Promise<unknown> | undefined;
  w.handlers.get("install")?.({
    waitUntil: (p: Promise<unknown>) => {
      install = p;
    },
  });
  await install;
  assert.deepEqual(w.cached, ["/", "/index.html", "/assets/app.js"]);
  let response: Promise<Response> | undefined;
  w.handlers.get("fetch")?.({
    request: { method: "GET", url: "https://lists.test/", mode: "navigate" },
    respondWith: (p: Promise<Response>) => {
      response = p;
    },
  });
  assert.equal(await (await response)?.text(), "offline-shell");
});
it("does not intercept API, auth, callback-query or foreign-origin traffic", () => {
  const w = worker();
  for (const url of [
    "https://lists.test/api/snapshot",
    "https://lists.test/auth/kakao/callback",
    "https://lists.test/?code=secret",
    "https://api.other.test/api/snapshot",
  ]) {
    let intercepted = false;
    w.handlers.get("fetch")?.({
      request: { method: "GET", url, mode: "navigate" },
      respondWith: () => {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false, url);
  }
});
