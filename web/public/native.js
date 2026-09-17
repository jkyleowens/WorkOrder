// Runtime bridge for the native (Capacitor) shells.
//
// The same files are served three ways: as the web console from /assets, as an
// installed PWA, and bundled inside the iOS/Android app. There is no bundler
// here, so this module never imports a Capacitor package — the native runtime
// injects the plugins it has on window.Capacitor.Plugins, and on the web that
// object simply does not exist. Every call therefore degrades to a no-op rather
// than throwing, which is also exactly what a plain browser needs.
const bridge = () => globalThis.Capacitor;
const plugin = (name) => bridge()?.Plugins?.[name];
export const isNative = () => Boolean(bridge()?.isNativePlatform?.());
export const platform = () => bridge()?.getPlatform?.() || "web";
// The bundled app is served from capacitor://localhost, so "/api" would resolve
// against the bundle instead of the server. scripts/build-mobile.mjs stamps the
// deployed origin in as __WORKORDER_API_BASE__; on the web it stays empty and
// requests stay same-origin exactly as before.
export const apiBase = () => {
  const base = globalThis.__WORKORDER_API_BASE__;
  return typeof base === "string" ? base.replace(/\/$/, "") : "";
};
// On the web these files are served under /assets; in the bundle they sit next
// to the page. Markup built inside a module has to ask rather than hard-code,
// because a bundled /assets/... would 404 against the app instead of the server.
export const assetUrl = (name) =>
  isNative() ? `./${name}` : `/assets/${name}`;
// The bundle has no /console or / document to navigate to — the console is
// always the current page, addressed by hash.
export const homeHref = (path) => (isNative() ? "#overview" : path);
// Fire-and-forget: a plugin that is missing, or a call that rejects because a
// permission was refused, must never take the app down with it.
async function callPlugin(name, method, options) {
  const target = plugin(name);
  if (!target?.[method]) return null;
  try {
    return await target[method](options);
  } catch {
    return null;
  }
}
// A clock event's coordinates, or null. Never throws and never blocks for
// long: a crew member clocking in must not wait on a GPS lock, and refusing
// location must not stop them recording their hours. Callers treat null as
// "no location", which is a perfectly valid entry.
//
// Native permission strings: NSLocationWhenInUseUsageDescription on iOS,
// ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION on Android.
export async function clockLocation({ timeoutMs = 5000 } = {}) {
  const fix = await Promise.race([
    currentPosition(timeoutMs),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]).catch(() => null);
  const c = fix?.coords;
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude))
    return null;
  return {
    clock_latitude: Number(c.latitude.toFixed(6)),
    clock_longitude: Number(c.longitude.toFixed(6)),
    clock_accuracy_m: Number.isFinite(c.accuracy)
      ? Number(c.accuracy.toFixed(1))
      : null,
  };
}
function currentPosition(timeoutMs) {
  const native = plugin("Geolocation");
  if (native?.getCurrentPosition)
    return native.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: timeoutMs,
    });
  if (!globalThis.navigator?.geolocation) return Promise.resolve(null);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
      enableHighAccuracy: true,
      timeout: timeoutMs,
      maximumAge: 60000,
    }),
  );
}
const listeners = [];
function listen(name, event, handler) {
  const target = plugin(name);
  if (!target?.addListener) return;
  try {
    const handle = target.addListener(event, handler);
    listeners.push(handle);
  } catch {
    /* a shell without this plugin just does not emit the event */
  }
}
// Called on resume and on regaining connectivity. Field time is queued in
// localStorage while offline; the server deduplicates on request_key, so
// draining more often than strictly necessary is safe.
let drain = null;
export const onResumeSync = (fn) => {
  drain = fn;
};
export async function setupNative() {
  if (!isNative()) return false;
  document.documentElement.classList.add("native-shell");
  // Status bar text has to be dark: the Industry palette is a light theme.
  await callPlugin("StatusBar", "setStyle", { style: "LIGHT" });
  listen("App", "appStateChange", ({ isActive }) => {
    if (isActive) drain?.();
  });
  // Android's hardware back button does nothing by default in a WebView. Walk
  // the hash history, and only leave the app from the top of the stack.
  listen("App", "backButton", ({ canGoBack }) => {
    if (canGoBack || (location.hash && location.hash !== "#overview"))
      history.back();
    else callPlugin("App", "exitApp");
  });
  // A deep link arrives as a full https:// URL; only its hash is meaningful to
  // a hash-routed console.
  listen("App", "appUrlOpen", ({ url }) => {
    const hash = String(url || "").split("#")[1];
    if (hash) location.hash = `#${hash}`;
  });
  await callPlugin("SplashScreen", "hide");
  return true;
}
