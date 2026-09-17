// Offline read cache for the console, and the registration for its shell
// worker (sw.js).
//
// Field crews lose signal on site, so the last real answer the server gave for
// each console API read is kept on the device — the same namespaced-localStorage
// approach field-store.js already uses for the offline time queue, under
// "workorder:console:" so it can never collide with the field queue.
//
// Nothing here invents data. A snapshot is replayed only when the network is
// unreachable, it is always a response the server really sent, and the moment
// one is used a banner says how old it is. An empty snapshot renders as the
// empty state it was, never as sample rows.
const NS = "workorder:console:";
const POINTER = NS + "user";
// Reads that happen before /me answers (the CSRF token) have no user yet.
const SHARED = "shared";
const MAX_ENTRY = 256 * 1024;
const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const put = (key, value) => {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};
const drop = (key) => {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Storage is unavailable; the console still works, just not offline. */
  }
};
const names = () => {
  try {
    return Object.keys(localStorage);
  } catch {
    return [];
  }
};
let user = read(POINTER);
const scopeFor = (path) => (path.startsWith("/api/auth/") ? SHARED : user);
const entryKey = (scope, path) => `${NS}${scope}:get:${path}`;
const entries = () => names().filter((k) => k.startsWith(NS) && k.includes(":get:"));
function forget() {
  for (const key of names()) if (key.startsWith(NS)) drop(key);
  user = null;
  staleAt = null;
  renderBanner();
}
// A different account on this device must never see the previous one's reads.
function adopt(text) {
  let id = null;
  try {
    id = JSON.parse(text)?.user?.id;
  } catch {
    return;
  }
  if (!id) return;
  const next = String(id);
  if (user === next) return;
  if (user) for (const key of names()) if (key.startsWith(NS)) drop(key);
  user = next;
  put(POINTER, next);
}
// localStorage is small, so when it fills up the oldest snapshots go first.
function prune() {
  const oldest = entries()
    .map((key) => {
      let at = "";
      try {
        at = JSON.parse(read(key) || "null")?.at || "";
      } catch {
        /* Unreadable entry: treat it as the oldest so it is dropped first. */
      }
      return { key, at };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const entry of oldest.slice(0, Math.ceil(oldest.length / 2) || 1))
    drop(entry.key);
}
function store(path, text) {
  if (path === "/api/me") adopt(text);
  const scope = scopeFor(path);
  if (!scope || text.length > MAX_ENTRY) return;
  const record = JSON.stringify({ at: new Date().toISOString(), body: text });
  if (!put(entryKey(scope, path), record)) {
    prune();
    put(entryKey(scope, path), record);
  }
}
function recall(path) {
  const scope = scopeFor(path);
  if (!scope) return null;
  const raw = read(entryKey(scope, path));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    return typeof record?.body === "string" ? record : null;
  } catch {
    return null;
  }
}
// ---- "showing last synced …" banner -----------------------------------------
// Styled from industry.css tokens, sat above the mobile tab bar and beside the
// desktop sidebar so it covers nothing the crew needs to tap.
const BANNER_CSS = `#offline-banner{position:fixed;inset:auto 0 0 0;z-index:14;display:flex;align-items:baseline;gap:10px;padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px));background:var(--amber-wash);border-top:1px solid var(--amber);color:var(--amber-strong);font-size:13px;line-height:1.35}
#offline-banner strong{flex:none;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase}
@media (max-width:800px){#offline-banner{bottom:calc(60px + env(safe-area-inset-bottom,0px));padding-bottom:10px}}
@media (min-width:801px){#offline-banner{left:242px}}
@media print{#offline-banner{display:none}}`;
let staleAt = null;
const synced = (at) => {
  const when = new Date(at);
  return Number.isNaN(when.valueOf())
    ? "an earlier visit"
    : when.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};
function renderBanner() {
  if (typeof document === "undefined" || !document.body) return;
  let banner = document.querySelector("#offline-banner");
  if (!staleAt) {
    banner?.remove();
    return;
  }
  if (!banner) {
    if (!document.querySelector("#offline-banner-style")) {
      const style = document.createElement("style");
      style.id = "offline-banner-style";
      style.textContent = BANNER_CSS;
      document.head.append(style);
    }
    banner = document.createElement("div");
    banner.id = "offline-banner";
    banner.setAttribute("role", "status");
    banner.innerHTML = "<strong>Offline</strong><span></span>";
    document.body.append(banner);
  }
  banner.querySelector("span").textContent =
    `Showing last synced ${synced(staleAt)}. This is saved data — nothing new loads until you reconnect.`;
}
function markStale(at) {
  if (!staleAt || at < staleAt) staleAt = at;
  renderBanner();
}
function markLive() {
  if (!staleAt) return;
  staleAt = null;
  renderBanner();
}
// ---- fetch interception -----------------------------------------------------
const methodOf = (input, init) =>
  String(
    init?.method || (typeof input === "object" && input?.method) || "GET",
  ).toUpperCase();
function apiPath(input) {
  const href = typeof input === "string" ? input : input?.url;
  if (!href) return null;
  let url;
  try {
    url = new URL(href, location.href);
  } catch {
    return null;
  }
  return url.pathname.startsWith("/api/") ? url.pathname + url.search : null;
}
async function intercept(network, input, init) {
  const path = apiPath(input);
  if (!path) return network(input, init);
  const method = methodOf(input, init);
  let response;
  try {
    response = await network(input, init);
  } catch (error) {
    const saved = method === "GET" ? recall(path) : null;
    if (!saved) throw error;
    markStale(saved.at);
    return new Response(saved.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-WorkOrder-Synced": saved.at,
      },
    });
  }
  markLive();
  if (path === "/api/auth/logout" && response.ok) forget();
  else if (
    method === "GET" &&
    response.ok &&
    (response.headers.get("Content-Type") || "").includes("json")
  )
    response
      .clone()
      .text()
      .then((text) => store(path, text))
      .catch(() => {});
  return response;
}
// The web app serves the worker at /sw.js and the console at /console; the
// native bundle keeps both at the bundle root. Resolving against the document
// covers either. The explicit /console scope keeps this worker away from
// /field, which field-sw.js registers for itself.
async function registerWorker() {
  if (!("serviceWorker" in navigator)) return null;
  const served = ["/console", "/login", "/register"].includes(
    location.pathname,
  );
  try {
    return await navigator.serviceWorker.register(
      new URL("sw.js", location.href).href,
      served ? { scope: "/console" } : undefined,
    );
  } catch {
    // No offline shell on this device; the console still runs online.
    return null;
  }
}
let installed = false;
export function installConsoleOffline() {
  if (installed) return;
  installed = true;
  const network = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => intercept(network, input, init);
  window.addEventListener("session-expired", forget);
  registerWorker();
}
