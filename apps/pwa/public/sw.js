const VERSION = "__SHELL_VERSION__";
const CACHE = `kakao-lists-shell-${VERSION}`;
const ASSETS = ["__SHELL_ASSETS__"];
const SHELL_PATHS = new Set(ASSETS);
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith("kakao-lists-shell-") && key !== CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.search ||
    url.pathname.startsWith("/auth/")
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(CACHE).then((cache) => cache.match("/index.html")),
      ),
    );
    return;
  }
  if (SHELL_PATHS.has(url.pathname))
    event.respondWith(
      caches
        .open(CACHE)
        .then(async (cache) => (await cache.match(request)) ?? fetch(request)),
    );
});
