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
