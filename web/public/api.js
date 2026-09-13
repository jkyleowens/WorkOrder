let csrf;
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
export async function api(
  path,
  { method = "GET", body, allowAnonymous = false } = {},
) {
  if (method !== "GET" && !csrf) await refreshCsrf();
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "GET" ? {} : { "X-CSRF-Token": csrf }),
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
