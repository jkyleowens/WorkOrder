// Keeps the refresh token out of localStorage on a real device.
//
// api.js defaults to localStorage, which is right for the web console (where
// the credential is a cookie and no token is stored at all) but wrong for a
// phone: a long-lived refresh token sitting in web storage is readable by any
// script that gets injected, and survives on a lost or shared handset.
//
// @capacitor/preferences writes to the iOS Keychain and the Android
// EncryptedSharedPreferences / Keystore, so the token lives where the platform
// protects it. Reached through the bridge Capacitor injects at
// window.Capacitor.Plugins rather than a bare import, because this project has
// no bundler and serves these files as raw ES modules.
//
// Native permission strings: none for storage. Biometric unlock additionally
// needs NSFaceIDUsageDescription on iOS.
import { useTokenStore } from "./api.js";
import { isNative } from "./native.js";
const plugin = () => globalThis.Capacitor?.Plugins?.Preferences || null;
// Preferences is asynchronous and api.js reads the token synchronously on every
// request, so the values are mirrored in memory and written through. The mirror
// is populated once at startup, before any request is made.
const cache = new Map();
function secureStore() {
  return {
    get: (key) => cache.get(key) ?? null,
    set: (key, value) => {
      const store = plugin();
      if (value === null) {
        cache.delete(key);
        store?.remove({ key });
      } else {
        cache.set(key, value);
        store?.set({ key, value });
      }
    },
  };
}
// Must be awaited before the first authenticated request, or a returning user
// looks signed out until the mirror fills. boot() does this.
export async function installSecureTokens(keys) {
  if (!isNative() || !plugin()) return false;
  const store = plugin();
  for (const key of keys) {
    try {
      const { value } = await store.get({ key });
      if (value != null) cache.set(key, value);
    } catch {
      // A key that cannot be read is treated as absent: the user signs in
      // again, which is recoverable. Failing the boot would not be.
    }
  }
  useTokenStore(secureStore());
  return true;
}
