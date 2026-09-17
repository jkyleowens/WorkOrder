import { apiBase, isNative } from "./native.js";
let csrf;
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
// Native clients hold a bearer token pair instead of a session cookie, because
// WKWebView will not keep a cookie for an origin other than the one the bundle
// is served from. On the web this whole layer stays dormant: no token is ever
// stored, so every request goes out exactly as it did before.
//
// Storage is behind these accessors so the token can move into the iOS Keychain
// or Android Keystore without touching any call site.
const ACCESS_KEY = "workorder:auth:access";
const REFRESH_KEY = "workorder:auth:refresh";
// Exported so secure-store.js can prime its mirror from the Keychain/Keystore
// before the first request goes out.
export const TOKEN_KEYS = [ACCESS_KEY, REFRESH_KEY];
let store = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      value === null
        ? localStorage.removeItem(key)
        : localStorage.setItem(key, value);
    } catch {
      /* private mode or blocked storage: the session just will not persist */
    }
  },
};
export const useTokenStore = (replacement) => {
  store = replacement;
};
export const accessToken = () => store.get(ACCESS_KEY);
export const hasTokens = () => Boolean(store.get(REFRESH_KEY));
export function setTokens(data) {
  store.set(ACCESS_KEY, data?.access_token ?? null);
  store.set(REFRESH_KEY, data?.refresh_token ?? null);
}
export const clearTokens = () => setTokens(null);
// One refresh at a time: a burst of parallel 401s must not rotate the refresh
// token several times over, which the server would read as token reuse and
// punish by revoking the whole chain.
let refreshing = null;
async function refreshTokens() {
  const refresh_token = store.get(REFRESH_KEY);
  if (!refresh_token) return false;
  refreshing ??= (async () => {
    const response = await fetch(`${apiBase()}/api/auth/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token }),
    });
    if (!response.ok) {
      clearTokens();
      return false;
    }
    setTokens(await response.json());
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}
// Sign in for a native client: same credentials, a token pair instead of a
// cookie. Returns the user so the caller can boot the console with it.
export async function signInWithToken(credentials) {
  const data = await api("/auth/token", {
    method: "POST",
    body: { ...credentials, device_label: navigator.userAgent.slice(0, 100) },
    allowAnonymous: true,
  });
  setTokens(data);
  return data.user;
}
// Shared transport for everything that talks to the API, including the file
// uploads that used to call fetch() directly. Adds the bearer token when there
// is one, and retries once after refreshing an expired access token.
export async function apiFetch(path, { headers = {}, ...init } = {}) {
  const send = () => {
    const token = accessToken();
    return fetch(`${apiBase()}${path}`, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  };
  let response = await send();
  if (response.status === 401 && hasTokens() && (await refreshTokens()))
    response = await send();
  return response;
}
export async function api(
  path,
  { method = "GET", body, allowAnonymous = false } = {},
) {
  // A bearer client has no session cookie, so the server exempts it from CSRF
  // and there is no token to fetch. Asking for one would only cost a round trip.
  if (method !== "GET" && !csrf && !hasTokens()) await refreshCsrf();
  let response;
  try {
    response = await apiFetch(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "GET" || hasTokens() ? {} : { "X-CSRF-Token": csrf }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(
      "Could not reach WorkOrder. Check your connection and try again.",
      0,
    );
  }
  const data =
    response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 403 && data?.error === "Invalid CSRF token") {
      csrf = null;
      try {
        await api("/me", { allowAnonymous: true });
      } catch (error) {
        if (error.status === 401 && !path.startsWith("/auth/")) {
          window.dispatchEvent(new Event("session-expired"));
          throw new ApiError("Your session ended. Sign in to continue.", 401);
        }
      }
      throw new ApiError(
        "Your session changed. Please try again; if needed, sign in again.",
        403,
      );
    }
    if (
      response.status === 401 &&
      !allowAnonymous &&
      !path.startsWith("/auth/")
    )
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      data?.details
        ?.map((d) => `${d.path.join(" ")}: ${d.message}`)
        .join(". ") ||
        data?.error ||
        "Something went wrong. Please try again.",
      response.status,
    );
  }
  if (data?.csrf_token) csrf = data.csrf_token;
  return data;
}
// File uploads post the raw bytes with the filename in a header, so they cannot
// go through api(), which is JSON-only. Three call sites used to hand-roll this
// fetch; they all need the bearer token and absolute base now.
export async function uploadFile(file) {
  const token = hasTokens() ? null : (await api("/auth/csrf")).csrf_token;
  const response = await apiFetch("/api/files", {
    method: "POST",
    headers: {
      ...(token ? { "X-CSRF-Token": token } : {}),
      "Content-Type": file.type,
      "X-Filename": encodeURIComponent(file.name),
    },
    body: file,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || "Upload failed");
  return result.id;
}
export async function refreshCsrf() {
  const data = await api("/auth/csrf");
  csrf = data.csrf_token;
}
export async function all(path) {
  const records = [];
  for (let offset = 0; ; offset += 100) {
    const rows = await api(
      `${path}${path.includes("?") ? "&" : "?"}limit=100&offset=${offset}`,
    );
    records.push(...rows);
    if (rows.length < 100) return records;
  }
}
export const write = (path, body = {}, method = "POST") =>
  api(path, { method, body });
