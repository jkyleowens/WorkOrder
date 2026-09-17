// Refuses to run a mobile build the server has declared too old.
//
// The native apps ship their web assets inside the binary, so an installed
// build keeps running its own JavaScript against this API until the user
// updates from the store. Without a gate there is no way to ever retire an API
// shape or stop a client-side bug that is corrupting records in the field.
//
// Two rules make this safe to have:
//   * It never blocks the web console, which reloads from the server and is
//     always current by definition.
//   * It never blocks a client that simply could not reach the server. A crew
//     member with no signal must still get into their timesheet — locking them
//     out on a jobsite would be far worse than running a slightly old build.
import { isNative } from "./native.js";
import { esc } from "./ui.js";
const clientVersion = () =>
  String(globalThis.__WORKORDER_CLIENT_VERSION__ || "0.0.0");
// Numeric compare, padded, so 0.10.0 sorts above 0.9.0.
const parts = (value) =>
  String(value || "0.0.0")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
export function olderThan(version, minimum) {
  const a = parts(version),
    b = parts(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] || 0,
      right = b[i] || 0;
    if (left !== right) return left < right;
  }
  return false;
}
function block(minimum) {
  const store =
    globalThis.Capacitor?.getPlatform?.() === "ios"
      ? "the App Store"
      : "Google Play";
  document.querySelector("#app").innerHTML =
    `<main id="main" class="auth-layout" aria-busy="false"><div class="auth-hero"><section class="auth-form-wrap"><div class="auth-form">` +
    `<p class="eyebrow">UPDATE REQUIRED</p><h2>This version of WorkOrder is out of date</h2>` +
    `<p>WorkOrder ${esc(clientVersion())} can no longer talk to the server safely. Version ${esc(minimum)} or newer is required.</p>` +
    `<p>Update WorkOrder from ${store}, then open it again. Any time you recorded on this device is still saved and will sync once you are on a supported version.</p>` +
    `</div></section></div></main>`;
}
// Returns true when the app must not continue. Any failure to ask — offline,
// server down, malformed answer — returns false: the gate only ever acts on a
// clear answer from the server.
export async function clientTooOld(apiBase = "") {
  if (!isNative()) return false;
  try {
    const response = await fetch(`${apiBase}/api/health`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const { min_client } = await response.json();
    if (!min_client || !olderThan(clientVersion(), min_client)) return false;
    block(min_client);
    return true;
  } catch {
    return false;
  }
}
