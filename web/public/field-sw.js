const CACHE = "workorder-field-v1";
const SHELL = [
  "/field",
  "/assets/field.js",
  "/assets/field.css",
  "/assets/field-store.js",
  "/assets/api.js",
  "/assets/ui.js",
  "/assets/styles.css",
  "/assets/industry.css",
  "/assets/fonts/barlow-regular.woff2",
  "/assets/fonts/barlow-medium.woff2",
  "/assets/fonts/barlow-bold.woff2",
  "/assets/fonts/barlow-condensed-semibold.woff2",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("workorder-field-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
// Cache the static shell only. Sessions, API records and private photos never enter shared caches.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== location.origin ||
    !SHELL.includes(url.pathname)
  )
    return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(url.pathname)),
  );
});
