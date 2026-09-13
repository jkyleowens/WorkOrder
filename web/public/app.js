import { mountTimeGrid } from "./time-grid.js";
import { api, all, write, refreshCsrf } from "./api.js";
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
const brand = `<a class="brand" href="/">${'<img src="/assets/mark.svg" alt="" width="32" height="32">'}WorkOrder<span>®</span></a>`;
function auth(register = location.pathname === "/register", message = "") {
  generation++;
  cleanupTimeGrid?.();
  cleanupTimeGrid = null;
  c.user = null;
  root.innerHTML = `<main id="main" class="auth-layout" aria-busy="false"><section class="auth-story">${brand}<div class="story-copy"><p class="eyebrow">THE WAY GOOD WORK HAPPENS</p><h1>Many ways to work.<br>One place to belong.</h1><p>Find your next opportunity. Bring your people together. Make something that matters.</p></div><div class="auth-diagram" aria-hidden="true"><div class="diagram-user"><span class="avatar">YOU</span><strong>One account. Every possibility.</strong></div><div class="diagram-branches"><span>Independent work</span><span>Your projects</span><span>Your organization</span></div></div><footer>Built around people. Ready for work.</footer></section><section class="auth-form-wrap"><div class="auth-mobile-brand">${brand}</div><div class="auth-form"><p class="eyebrow">${register ? "START YOUR NEXT CHAPTER" : "YOUR WORKSPACE IS WAITING"}</p><h2>${register ? "Create your account" : "Welcome back"}</h2><p>${register ? "A little about you. A world of possibilities." : "Sign in to pick up where you left off."}</p><form id="auth-form">${register ? field("Full name", "full_name", "text", "", 'required maxlength="120" autocomplete="name"') : ""}${field("Email address", "email", "email", "", 'required maxlength="254" autocomplete="email"')}${field("Password", "password", "password", "", `required ${register ? 'minlength="12"' : ""} autocomplete="${register ? "new-password" : "current-password"}"`)}<label class="show-password"><input type="checkbox" id="show-password"> Show password</label>${register ? '<p class="hint">Use at least 12 characters (up to 72 bytes).</p>' : ""}<p class="form-error" role="alert" ${message ? "" : "hidden"}>${esc(message)}</p><button class="btn primary auth-submit" type="submit">${register ? "Create account" : "Sign in"} ${icon("arrow")}</button></form><p class="auth-switch">${register ? 'Already part of WorkOrder? <a href="/login">Sign in</a>' : 'New to WorkOrder? <a href="/register">Create an account</a>'}</p><div class="auth-note">${icon("check")} One account for your work, your clients, and your team.</div></div><footer class="auth-footer">WorkOrder · Your work, in order.</footer></section></main>`;
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
      const result = await write(
        register ? "/auth/register" : "/auth/login",
        data,
      );
      c.user = result.user;
      history.replaceState(null, "", "/console#overview");
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
const navigation = [
  ["overview", "Overview", "overview"],
  ["inbox", "Inbox", "inbox"],
  ["projects", "Projects", "projects"],
  ["billing", "Billing", "billing"],
  ["jobs", "Employment", "jobs"],
  ["time", "Time & reports", "time"],
  ["inventory", "Inventory", "inventory"],
  ["organizations", "Organizations", "people"],
  ["people", "People & skills", "people"],
  ["profile", "My profile", "profile"],
];
function shell(route) {
  const selected =
    route === "application"
      ? "billing"
      : route === "project"
        ? "projects"
        : route === "job"
          ? "jobs"
          : route === "organization"
            ? "organizations"
            : route;
  root.innerHTML = `<div class="console"><aside class="sidebar">${brand}<p class="nav-caption">WORKSPACE</p><nav aria-label="Main navigation">${navigation.map(([key, label, i]) => `<a href="#${key}" aria-label="${label}" ${selected === key ? 'aria-current="page"' : ""}>${icon(i)}<span>${label}</span>${key === "inbox" && c.unread ? `<span class="unread-count">${c.unread > 99 ? "99+" : c.unread}</span>` : ""}${selected === key ? '<span class="nav-dot"></span>' : ""}</a>`).join("")}</nav><div class="sidebar-note"><span class="eyebrow">ALL YOUR WORK. ALL OF YOU.</span><p>Good things happen<br>when people work together.</p></div><div class="account"><a href="#profile" class="avatar">${initials(c.user.full_name)}</a><div class="grow"><strong>${esc(c.user.full_name)}</strong><small>${esc(c.user.availability_status)}</small></div><button type="button" data-action="logout" aria-label="Sign out">${icon("logout")}</button></div></aside><div class="workspace"><header class="topbar"><span><span class="breadcrumb">Workspace</span><span class="slash">/</span>${esc(navigation.find(([key]) => key === selected)?.[1] || "Overview")}</span><div class="topbar-right"><a class="inbox-shortcut" href="#inbox" aria-label="Open inbox${c.unread ? `, ${c.unread} unread` : ""}">${icon("inbox")}${c.unread ? `<span class="unread-indicator"></span>` : ""}</a><span class="context-pill"><i></i>${esc(c.org?.name || "Connected workspace")}</span><span class="top-date">${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span></div></header><main id="main" aria-busy="true"><div class="loading"><span class="loading-dot"></span>Loading your workspace…</div></main><footer class="workspace-footer"><span>WorkOrder</span><span>Your work, in order.</span></footer></div></div>`;
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
document.addEventListener("click", async (e) => {
  if (e.target.closest(".skip")) {
    e.preventDefault();
    const main = document.querySelector("#main");
    main.tabIndex = -1;
    main.focus();
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
window.addEventListener("session-expired", () => {
  document.querySelector("#modal").close();
  history.replaceState(null, "", "/login");
  auth(false, "Your session ended. Sign in to continue.");
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) boot();
});
async function boot() {
  try {
    await refreshCsrf();
    let me;
    try {
      me = await api("/me", { allowAnonymous: true });
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    if (me) {
      c.user = me.user;
      history.replaceState(null, "", `/console${location.hash || "#overview"}`);
      await c.reload();
    } else auth(location.pathname === "/register");
  } catch (error) {
    auth(location.pathname === "/register", error.message);
  }
}
boot();
