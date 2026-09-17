// Offline shell for the console SPA. The /field workspace keeps its own worker
// (field-sw.js, registered with scope "/field"); this one is registered with
// scope "/console" so the two never control the same client and the offline
// time queue that already works stays untouched.
const CACHE = "workorder-console-v1";
// The console's real module graph, plus the stylesheets and the locally hosted
// fonts industry.css asks for. Paths stay relative to this worker.
const FILES = [
  "app.js",
  "pages.js",
  "actions.js",
  "ui.js",
  "api.js",
  "native.js",
  "billing.js",
  "trust.js",
  "time-grid.js",
  "time-entry.js",
  "field-console.js",
  "field-store.js",
  "console-store.js",
  "styles.css",
  "industry.css",
  "mark.svg",
  "fonts/barlow-regular.woff2",
  "fonts/barlow-medium.woff2",
  "fonts/barlow-bold.woff2",
  "fonts/barlow-condensed-semibold.woff2",
];
// Two layouts share this file. The web app serves the worker at /sw.js with the
// modules under /assets and the shell document at /console; the native bundle
// copies every file next to the worker and opens index.html. Both are listed
// and resolved against the worker's own URL, so whichever one is real gets
// cached and the other simply fails to precache.
const LAYOUTS = [
  { base: "assets/", document: "console" },
  { base: "", document: "index.html" },
];
const at = (path) => new URL(path, self.location).href;
const DOCUMENTS = LAYOUTS.map((layout) => at(layout.document));
const SHELL = new Set([
  ...DOCUMENTS,
  ...LAYOUTS.flatMap((layout) => FILES.map((file) => at(layout.base + file))),
]);
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Per entry, not addAll: the layout that is not in use 404s, and one
      // missing file must never leave the console with no offline shell.
      .then((cache) =>
        Promise.all([...SHELL].map((url) => cache.add(url).catch(() => {}))),
      )
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
            .filter((k) => k.startsWith("workorder-console-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
// Cache the static shell only. Sessions, API records and private photos never
// enter shared caches; console-store.js keeps read snapshots per user instead.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  // field-sw.js owns the field workspace in every layout.
  if (
    url.pathname === "/field" ||
    url.pathname.startsWith("/field/") ||
    url.pathname === "/field-sw.js"
  )
    return;
  // A cold offline launch still has to render the shell, so navigations fall
  // back to the cached console document.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        for (const doc of DOCUMENTS) {
          const hit = await caches.match(doc);
          if (hit) return hit;
        }
        return Response.error();
      }),
    );
    return;
  }
  if (!SHELL.has(url.href)) return;
  event.respondWith(
    fetch(request).catch(
      async () => (await caches.match(url.href)) || Response.error(),
    ),
  );
});
