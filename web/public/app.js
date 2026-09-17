import { mountTimeEntry } from "./time-entry.js";
import { mountTimeGrid } from "./time-grid.js";
import { mountField, syncField } from "./field-console.js";
import {
  api,
  all,
  write,
  refreshCsrf,
  signInWithToken,
  clearTokens,
  hasTokens,
  TOKEN_KEYS,
} from "./api.js";
import { installSecureTokens } from "./secure-store.js";
import {
  isNative,
  setupNative,
  onResumeSync,
  assetUrl,
  homeHref,
} from "./native.js";
import {
  esc,
  initials,
  icon,
  toast,
  today,
  field,
  heading,
  button,
} from "./ui.js";
import { installConsoleOffline } from "./console-store.js";
import { renderPage } from "./pages.js";
import { action } from "./actions.js";
const root = document.querySelector("#app");
const week = () => {
  const start = new Date(today() + "T12:00:00");
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
};
const c = {
  user: null,
  memberships: [],
  data: {},
  range: week(),
  currentWeek: week(),
  org: null,
  manages(id) {
    return this.memberships.some(
      (m) => m.org_id === id && ["owner", "manager"].includes(m.internal_role),
    );
  },
  navigate(route) {
    if (location.hash.slice(1) === route) this.reload();
    else location.hash = route;
  },
};
let cleanupTimeGrid;
let generation = 0,
  authBusy = false;
const brand = `<a class="brand" href="${homeHref("/")}"><img src="${assetUrl("mark.svg")}" alt="" width="32" height="32">WorkOrder<span>®</span></a>`;
// The bundled app is served from capacitor://localhost, where the pathname is
// always /index.html — so which auth screen to show, and the tidy-up URLs the
// web console writes, have to come from the hash instead.
const wantsRegister = () =>
  isNative()
    ? location.hash === "#register"
    : location.pathname === "/register";
const setUrl = (url) => {
  if (!isNative()) history.replaceState(null, "", url);
};
function auth(register = wantsRegister(), message = "") {
  generation++;
  cleanupTimeGrid?.();
  cleanupTimeGrid = null;
  c.user = null;
  root.innerHTML = `<main id="main" class="auth-layout" aria-busy="false"><div class="auth-hero"><section class="auth-story">${brand}<div class="story-copy"><p class="eyebrow">BUILT FOR TRADE WORK</p><h1>Every job, broken into work that gets done.</h1><p>Post a project once, and split it into scopes that are bid, staffed, timed, and paid on their own — for the crew doing the work and the client footing the bill.</p></div><div class="auth-diagram" aria-hidden="true"><div class="diagram-user"><span class="avatar">YOU</span><strong>One account. Every possibility.</strong></div><div class="diagram-branches"><span>Independent work</span><span>Your projects</span><span>Your organization</span></div></div><footer>${'<a href="/">← WorkOrder home</a>'}</footer></section><section class="auth-form-wrap"><div class="auth-mobile-brand">${brand}</div><div class="auth-form"><p class="eyebrow">${register ? "START YOUR NEXT CHAPTER" : "YOUR WORKSPACE IS WAITING"}</p><h2>${register ? "Create your account" : "Welcome back"}</h2><p>${register ? "A little about you. A world of possibilities." : "Sign in to pick up where you left off."}</p><form id="auth-form">${register ? field("Full name", "full_name", "text", "", 'required maxlength="120" autocomplete="name"') : ""}${field("Email address", "email", "email", "", 'required maxlength="254" autocomplete="email"')}${field("Password", "password", "password", "", `required ${register ? 'minlength="12"' : ""} autocomplete="${register ? "new-password" : "current-password"}"`)}<label class="show-password"><input type="checkbox" id="show-password"> Show password</label>${register ? '<p class="hint">Use at least 12 characters (up to 72 bytes).</p>' : ""}<p class="form-error" role="alert" ${message ? "" : "hidden"}>${esc(message)}</p><button class="btn primary auth-submit" type="submit">${register ? "Create account" : "Sign in"} ${icon("arrow")}</button></form><p class="auth-switch">${register ? 'Already part of WorkOrder? <a href="/login">Sign in</a>' : 'New to WorkOrder? <a href="/register">Create an account</a>'}</p><div class="auth-note">${icon("check")} One account for your work, your clients, and your team.</div></div></section></div></main>`;
  document.querySelector("#show-password").onchange = (e) =>
    (document.querySelector("[name=password]").type = e.target.checked
      ? "text"
      : "password");
  document.querySelector("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    if (authBusy) return;
    authBusy = true;
    const form = e.target,
      submit = form.querySelector("button[type=submit]"),
      error = form.querySelector(".form-error");
    submit.disabled = true;
    error.hidden = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      if (register && new TextEncoder().encode(data.password).length > 72)
        throw new Error(
          "Password must be at most 72 bytes. Try a shorter password.",
        );
      // Native has no usable cookie, so it trades the same credentials for a
      // token pair. Registering still goes through the normal endpoint; the
      // token exchange immediately afterwards is what signs the device in.
      if (isNative()) {
        if (register) await write("/auth/register", data);
        c.user = await signInWithToken({
          email: data.email,
          password: data.password,
        });
      } else {
        const result = await write(
          register ? "/auth/register" : "/auth/login",
          data,
        );
        c.user = result.user;
      }
      setUrl("/console#overview");
      await c.reload();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      authBusy = false;
      submit.disabled = false;
    }
  };
}
// Field work, billing and inventory live under each organization now (see
// the organization page's control panel) rather than the main sidebar, and
// trust & verification lives under My profile — this keeps the main nav to
// what applies everywhere, regardless of which org a scope belongs to.
const navGroups = [
  [
    "Work",
    [
      ["overview", "Overview", "overview"],
      ["projects", "Projects", "projects"],
      ["time", "Time & reports", "time"],
    ],
  ],
  [
    "People",
    [
      ["inbox", "Inbox", "inbox"],
      ["jobs", "Employment", "jobs"],
      ["organizations", "Organizations", "people"],
      ["people", "People & skills", "people"],
    ],
  ],
  ["Account", [["profile", "My profile", "profile"]]],
];
const navigation = navGroups.flatMap(([, items]) => items);
// Routes reached only through an organization or a profile page, not the
// main nav — kept here so the breadcrumb still names them correctly.
const routeLabels = Object.fromEntries([
  ...navigation.map(([key, label]) => [key, label]),
  ["field", "Field work"],
  ["billing", "Billing"],
  ["inventory", "Inventory"],
  ["credentials", "Trust & verification"],
]);
const mobileTabs = [
  ["overview", "Overview", "overview"],
  ["field", "Field", "time"],
  ["time", "Time", "time"],
  ["inbox", "Inbox", "inbox"],
];
const navLink = (key, label, i, selected) =>
  `<a href="#${key}" aria-label="${label}" ${selected === key ? 'aria-current="page"' : ""}>${icon(i)}<span>${label}</span>${key === "inbox" && c.unread ? `<span class="unread-count">${c.unread > 99 ? "99+" : c.unread}</span>` : ""}${selected === key ? '<span class="nav-dot"></span>' : ""}</a>`;
const navGroupsHtml = (selected) =>
  navGroups
    .map(
      ([caption, items]) =>
        `<p class="nav-caption">${esc(caption)}</p><nav aria-label="${esc(caption)}">${items.map(([key, label, i]) => navLink(key, label, i, selected)).join("")}</nav>`,
    )
    .join("");
function shell(route) {
  const selected = ["application", "waiver", "waivers"].includes(route)
    ? "billing"
    : route === "project"
      ? "projects"
      : route === "job"
        ? "jobs"
        : route === "organization"
          ? "organizations"
          : route;
  root.innerHTML = `<div class="console"><aside class="sidebar">${brand}${navGroupsHtml(selected)}<div class="sidebar-note"><span class="eyebrow">ALL YOUR WORK. ALL OF YOU.</span><p>Good things happen<br>when people work together.</p></div><div class="account"><a href="#profile" class="avatar">${initials(c.user.full_name)}</a><div class="grow"><strong>${esc(c.user.full_name)}</strong><small>${esc(c.user.availability_status)}</small></div><button type="button" data-action="logout" aria-label="Sign out">${icon("logout")}</button></div></aside><div class="workspace"><header class="topbar"><span><span class="breadcrumb">Workspace</span><span class="slash">/</span>${esc(routeLabels[selected] || "Overview")}</span><div class="topbar-right"><a class="inbox-shortcut" href="#inbox" aria-label="Open inbox${c.unread ? `, ${c.unread} unread` : ""}">${icon("inbox")}${c.unread ? `<span class="unread-indicator"></span>` : ""}</a><span class="context-pill"><i></i>${esc(c.org?.name || "Connected workspace")}</span><span class="top-date">${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span></div></header><main id="main" aria-busy="true"><div class="loading"><span class="loading-dot"></span>Loading your workspace…</div></main><footer class="workspace-footer"><span>WorkOrder</span><span>Your work, in order.</span></footer></div><nav class="mobile-tabbar" aria-label="Primary">${mobileTabs.map(([key, label, i]) => `<a class="mobile-tab" href="#${key}" ${selected === key ? 'aria-current="page"' : ""}>${icon(i)}<span>${label}</span>${key === "inbox" && c.unread ? `<span class="unread-count">${c.unread > 99 ? "99+" : c.unread}</span>` : ""}</a>`).join("")}<button type="button" class="mobile-tab" data-nav-toggle="more" aria-haspopup="dialog" aria-expanded="false">${icon("more")}<span>More</span></button></nav><div class="more-sheet"><div class="more-backdrop" data-nav-close></div><div class="more-panel" role="dialog" aria-modal="true" aria-label="More navigation"><div class="more-panel-head"><p class="eyebrow">WorkOrder</p><button type="button" class="close" data-nav-close aria-label="Close">${icon("close")}</button></div>${navGroupsHtml(selected)}<button type="button" class="more-signout" data-action="logout">${icon("logout")}<span>Sign out</span></button></div></div></div>`;
}
c.reload = async () => {
  cleanupTimeGrid?.();
  cleanupTimeGrid = null;
  const current = ++generation;
  if (c.user) {
    const main = document.querySelector("#main");
    if (main) {
      main.setAttribute("aria-busy", "true");
      main.innerHTML = '<div class="loading">Loading your workspace…</div>';
    }
  }
  const [path, query = ""] = (location.hash.slice(1) || "overview").split("?");
  const [route, part] = path.split("/");
  const page = Math.max(
    0,
    Math.min(50000, Number(new URLSearchParams(query).get("page")) || 0),
  );
  try {
    const me = await api("/me");
    const [memberships, unread] = await Promise.all([
      all("/organizations"),
      api("/notifications/unread-count"),
    ]);
    if (current !== generation) return;
    c.unread = unread.count;
    c.user = me.user;
    c.memberships = memberships;
    // Bidding and inventory now always go through an organization (even a
    // solo one) rather than offering a separate personal path — this is the
    // org a route falls back to when none is given explicitly in the URL.
    c.primaryOrg = memberships[0]?.org_id || null;
    c.org = [
      "organization",
      "inventory",
      "time",
      "org-projects",
      "org-bids",
      "org-jobs",
    ].includes(route)
      ? memberships.find((m) => m.org_id === Number(part))?.organization || null
      : null;
    shell(route);
    c.currentWeek = week();
    const view = { ...c };
    const html = await renderPage(view, route, part, page);
    if (current !== generation) return;
    c.data = view.data;
    const main = document.querySelector("#main");
    main.innerHTML = html;
    cleanupTimeGrid = mountTimeGrid(main, c.data, c.range);
    mountTimeEntry(main, c);
    mountField(main, c);
    main.setAttribute("aria-busy", "false");
    if (!document.querySelector("#modal").open)
      main.querySelector("h1")?.focus({ preventScroll: true });
    document.title = `${main.querySelector("h1")?.textContent || "Workspace"} · WorkOrder`;
    const range = document.querySelector("#range-form");
    if (range)
      range.onsubmit = (e) => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(e.target));
        const days =
          (Date.parse(values.to) - Date.parse(values.from)) / 86400000;
        if (days < 0 || days > 366) {
          toast("Choose an ordered date range of no more than 366 days.");
          return;
        }
        c.range = values;
        c.reload();
      };
  } catch (error) {
    if (current !== generation) return;
    if (error.status === 401)
      return auth(false, "Your session ended. Sign in to continue.");
    // Offline with a session already established: keep working from cached
    // data instead of hard-failing every route. Routes with no offline
    // fallback of their own (most of them — they need live data) will throw
    // again below and fall through to the normal error view.
    if (c.user && (!navigator.onLine || !error.status)) {
      try {
        shell(route);
        c.currentWeek = week();
        const view = { ...c };
        const html = await renderPage(view, route, part, page);
        if (current !== generation) return;
        c.data = view.data;
        const main = document.querySelector("#main");
        main.innerHTML = html;
        cleanupTimeGrid = mountTimeGrid(main, c.data, c.range);
        mountTimeEntry(main, c);
        mountField(main, c);
        main.setAttribute("aria-busy", "false");
        return;
      } catch {
        // No offline fallback for this route — show the error view below.
      }
    }
    if (!c.user) {
      root.innerHTML = `<main id="main" class="boot">${brand}<h1>We couldn’t open WorkOrder</h1><p role="alert">${esc(error.message)}</p>${button("Try again", "retry", "", "primary")}</main>`;
    } else {
      const main = document.querySelector("#main");
      main.innerHTML = heading(
        "Workspace",
        "Unable to load this view",
        error.message,
        button("Try again", "retry", "", "primary"),
      );
      main.setAttribute("aria-busy", "false");
    }
  }
};
let actionBusy = false;
function setMoreOpen(open) {
  const sheet = document.querySelector(".more-sheet");
  const tab = document.querySelector('[data-nav-toggle="more"]');
  if (!sheet) return;
  sheet.classList.toggle("open", open);
  tab?.setAttribute("aria-expanded", String(open));
  // Keep keyboard and screen-reader focus out of the content the backdrop
  // covers while the sheet is open; restore it on close before refocusing.
  document.querySelector(".workspace")?.toggleAttribute("inert", open);
  document.querySelector(".mobile-tabbar")?.toggleAttribute("inert", open);
  if (open) sheet.querySelector("a, button:not(.close)")?.focus();
  else tab?.focus();
}
document.addEventListener("click", async (e) => {
  if (e.target.closest(".skip")) {
    e.preventDefault();
    const main = document.querySelector("#main");
    main.tabIndex = -1;
    main.focus();
    return;
  }
  if (e.target.closest("[data-nav-close]")) {
    setMoreOpen(false);
    return;
  }
  if (e.target.closest("[data-nav-toggle=more]")) {
    setMoreOpen(
      !document.querySelector(".more-sheet")?.classList.contains("open"),
    );
    return;
  }
  if (e.target.closest(".more-panel a")) setMoreOpen(false);
  const dismiss = e.target.closest("[data-dismiss]");
  if (dismiss) {
    localStorage.setItem(`workorder:dismissed:${dismiss.dataset.dismiss}`, "1");
    dismiss.closest(".billing-notice")?.remove();
    return;
  }
  const target = e.target.closest("[data-action]");
  if (!target || actionBusy) return;
  actionBusy = true;
  target.disabled = true;
  try {
    await action(c, target.dataset.action, target.dataset.id);
  } catch (error) {
    toast(error.message);
  } finally {
    actionBusy = false;
    if (target.isConnected) target.disabled = false;
  }
});
window.addEventListener("hashchange", () => {
  if (c.user) c.reload();
});
window.addEventListener("online", () => {
  if (!c.user) return;
  syncField(c.user.id)
    .catch(() => {})
    .then(() => c.reload());
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.querySelector(".more-sheet.open"))
    setMoreOpen(false);
});
window.addEventListener("session-expired", () => {
  document.querySelector("#modal").close();
  setUrl("/login");
  auth(false, "Your session ended. Sign in to continue.");
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) boot();
});
// Installed before boot so the very first reads of a cold offline launch can
// still be served from the last snapshot.
installConsoleOffline();
async function boot() {
  try {
    await setupNative();
    // Before anything reads a token: on a device this moves it out of web
    // storage and into the Keychain / Keystore, and loads what is already
    // there so a returning user is not asked to sign in again.
    await installSecureTokens(TOKEN_KEYS);
    // Resuming from the background is the moment a phone most often regains
    // signal, so drain any field time queued while it was offline.
    onResumeSync(() => {
      if (c.user)
        syncField(c.user.id)
          .catch(() => {})
          .then(() => c.reload());
    });
    // A bearer client is exempt from CSRF and has no cookie to seed, so asking
    // for a token would only cost a round trip on a jobsite connection.
    if (!hasTokens()) await refreshCsrf();
    let me;
    try {
      me = await api("/me", { allowAnonymous: true });
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    if (me) {
      c.user = me.user;
      setUrl(`/console${location.hash || "#overview"}`);
      await c.reload();
    } else auth(wantsRegister());
  } catch (error) {
    auth(wantsRegister(), error.message);
  }
}
boot();
