import { renderTrust, reputationSummary } from "./trust.js";
import { renderField } from "./field-console.js";
import { timeEntryForm } from "./time-entry.js";
import {
  renderBilling,
  renderApplication,
  renderWaiver,
  renderWaiverChain,
} from "./billing.js";
import { timeGrid } from "./time-grid.js";
import { api, all } from "./api.js";
import {
  typeBadges,
  esc,
  money,
  today,
  dateLabel,
  status,
  initials,
  icon,
  button,
  link,
  field,
  select,
  empty,
  heading,
  panel,
  table,
  row,
} from "./ui.js";
const active = (s) => ["awarded", "active"].includes(s.status);
const tabs = (items, current) =>
  `<nav class="tabs" aria-label="Section">${items.map(([key, label, path]) => `<a href="#${path}" ${key === current ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
const stats = (items) =>
  `<div class="stats">${items.map(([label, value, note]) => `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join("")}</div>`;
const pager = (route, number, count) =>
  `<div class="pager"><a class="btn secondary ${number === 0 ? "disabled" : ""}" ${number === 0 ? 'aria-disabled="true" tabindex="-1"' : ""} href="#${route}?page=${Math.max(0, number - 1)}">Previous</a><span>Page ${number + 1}</span><a class="btn secondary ${count < 20 ? "disabled" : ""}" ${count < 20 ? 'aria-disabled="true" tabindex="-1"' : ""} href="#${route}?page=${number + 1}">Next</a></div>`;
const paged = (path, page) => api(`${path}?limit=20&offset=${page * 20}`);
const organizationName = (c, id) =>
  c.memberships.find((m) => m.org_id === id)?.organization.name ||
  "Organization";
const orgPath = (c) => (c.org ? `/organizations/${c.org.id}` : "");
const assignmentTitle = (s) =>
  s.project ? `${s.project.title} · ${s.scope}` : s.scope;
const payLabel = (rate) =>
  rate == null ? "Pay not specified" : `${money(rate)} / hour`;
const paySummary = (a) =>
  `<strong>Requested ${payLabel(a.desired_rate)}</strong><small>${a.status === "accepted" ? "Agreed" : "Offered"}: ${payLabel(a.offered_rate)}</small>`;
const laborTable = (entries, name) => {
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.user_id}:${e.hourly_rate}`;
    const group = groups.get(key) || { ...e, hours: 0, labor_cost: 0 };
    group.hours += Number(e.hours);
    group.labor_cost += Number(e.labor_cost);
    groups.set(key, group);
  }
  return table(
    ["Worker", "Hours", "Saved hourly rate", "Labor cost"],
    [...groups.values()].map((e) =>
      row([
        esc(e.full_name || name?.(e.user_id) || `Worker ${e.user_id}`),
        e.hours.toFixed(2),
        money(e.hourly_rate),
        money(e.labor_cost),
      ]),
    ),
  );
};
export async function renderPage(c, route, part, page = 0) {
  if (route === "field") return renderField(c);
  c.data = {};
  const d = c.data;
  if (
    [
      "credentials",
      "trust-profile",
      "trust-organization",
      "trust-admin",
      "scope-trust",
      "dispute",
    ].includes(route)
  )
    return renderTrust(c, route, part);
  if (route === "billing") return renderBilling(c, part, page);
  if (route === "application") return renderApplication(c, part);
  if (route === "waiver") return renderWaiver(c, part);
  if (route === "waivers") return renderWaiverChain(c, part);
  if (route === "inbox") {
    const unreadOnly = part === "unread";
    const result = await api(
      `/notifications?limit=20&offset=${page * 20}${unreadOnly ? "&unread=true" : ""}`,
    );
    d.notifications = result;
    return (
      heading(
        "YOUR UPDATES",
        "Inbox",
        "Hiring updates and project activity, together in one place.",
        c.unread ? button("Mark all as read", "read-all") : "",
      ) +
      tabs(
        [
          ["all", "All activity", "inbox"],
          ["unread", `Unread (${c.unread || 0})`, "inbox/unread"],
        ],
        unreadOnly ? "unread" : "all",
      ) +
      (result.length
        ? `<section class="inbox-list" aria-label="Notifications">${result.map((n) => `<article class="notification ${n.read_at ? "" : "is-unread"}"><span class="square-icon">${icon("inbox")}</span><div class="grow"><div class="notification-meta"><span class="eyebrow">${n.read_at ? "READ" : "NEW UPDATE"}</span><time datetime="${esc(n.created_at)}">${esc(dateLabel(n.created_at))}</time></div><h2>${esc(n.title)}</h2><p>${esc(n.body)}</p><div class="actions">${link("View details", n.route)}${!n.read_at ? button("Mark as read", "read-notification", n.id) : ""}</div></div></article>`).join("")}</section>` +
          pager(unreadOnly ? "inbox/unread" : "inbox", page, result.length)
        : empty(
            unreadOnly
              ? "You’re all caught up"
              : "Your updates will appear here",
            unreadOnly
              ? "You have no unread notifications."
              : "We’ll let you know when applications, pay requests, offers, and bids need your attention.",
            "",
            unreadOnly ? "check" : "inbox",
          ))
    );
  }
  if (route === "overview") {
    const overviewOrg = c.org?.id || c.primaryOrg;
    const [projects, assignments, applications, inventory, report] =
      await Promise.all([
        all("/me/projects"),
        all("/me/assignments"),
        all("/applications"),
        overviewOrg ? all(`/organizations/${overviewOrg}/inventory`) : [],
        api(
          c.org
            ? `${orgPath(c)}/dashboard?from=${c.currentWeek.from}&to=${c.currentWeek.to}`
            : `/time/week?date=${today()}`,
        ),
      ]);
    const clientMode = false;
    const work = clientMode
      ? projects
          .filter((p) => ["open", "active"].includes(p.status))
          .map((p) => ({
            project_id: p.id,
            project: p,
            scope: p.description,
            status: p.status,
          }))
      : assignments.filter(
          (s) => active(s) && (!c.org || s.awarded_org_id === c.org.id),
        );
    const setupSteps = [
      ["Create your account", true, ""],
      [
        "Create your organization — even solo work goes through one",
        c.memberships.length > 0,
        button("Create organization", "organization", "", "primary"),
      ],
      [
        "Add your hourly rate and a skill",
        Number(c.user.hourly_rate) > 0 && c.user.skills.length > 0,
        link("Complete profile", "profile", "primary"),
      ],
      [
        "Bid on a scope or post a project",
        work.length > 0 || projects.length > 0,
        link("Open market", "projects", "primary"),
      ],
      [
        "Log your first hours",
        Number(report.hours) > 0,
        link("Log time", "time", "primary"),
      ],
    ];
    const setupDone = setupSteps.filter(([, done]) => done).length;
    const offerCount = applications.filter(
      (a) => a.status === "offered",
    ).length;
    const nextUp = [
      offerCount
        ? `<a class="list-row" href="#jobs/applications"><span class="square-icon">${icon("jobs")}</span><span class="grow"><strong>${offerCount} offer${offerCount === 1 ? "" : "s"} to review</strong><small>Respond to employers and join a team.</small></span>${icon("arrow")}</a>`
        : "",
      !c.memberships.length
        ? `<a class="list-row" href="#organizations"><span class="square-icon">${icon("people")}</span><span class="grow"><strong>Your people, in one place</strong><small>Create or manage an organization.</small></span>${icon("arrow")}</a>`
        : "",
    ]
      .filter(Boolean)
      .join("");
    return (
      heading(
        c.org
          ? "Organization overview"
          : clientMode
            ? "Client overview"
            : "Your workspace",
        c.org ? c.org.name : `Welcome back, ${c.user.full_name.split(" ")[0]}.`,
        c.org
          ? "A shared view of your team’s work, hours, and materials."
          : "One place for the work you do, the people you hire, and what comes next.",
        clientMode
          ? button("Post a project", "project", "", "primary")
          : button("Log time", "log-time", "", "primary"),
      ) +
      `<section class="welcome-band"><div><span class="eyebrow">${clientMode ? "Client workbench" : work.length ? "Contractor workbench" : "Start your next contract"}</span><h2>${clientMode ? "Move your projects forward." : work.length ? "Record the work. Keep progress visible." : "Find the right work. Build your reputation."}</h2><p>${clientMode ? "Review your work packages, agree scope changes, and certify applications." : work.length ? "Your assignments, hours, and billing records are connected to the same scopes." : "Build your profile, explore open projects, or post work for your team."}</p><div class="actions">${link(clientMode ? "Review projects" : work.length ? "Your assignments" : "Explore projects", clientMode ? "projects/mine" : work.length ? "projects/work" : "projects", "primary")}${link(clientMode || work.length ? "Open billing" : "Find a job", clientMode || work.length ? "billing" : "jobs")}</div></div></section>` +
      stats([
        [
          "Hours this week",
          Number(report.hours).toFixed(2),
          c.org ? "Across your organization" : "Across all your work",
        ],
        [
          clientMode ? "Active client projects" : "Active assignments",
          work.length,
          c.org
            ? "Awarded to your organization"
            : clientMode
              ? "Open and active projects"
              : "Solo and organization work",
        ],
        [
          c.org ? "Labor cost" : "Your projects",
          c.org ? money(report.labor_cost) : projects.length,
          c.org ? "This week · saved rates" : "Projects you have posted",
        ],
        [
          "Inventory items",
          inventory.length,
          overviewOrg
            ? "Your organization’s stock"
            : "Create an organization to track stock",
        ],
      ]) +
      `<div class="columns">${panel(
        clientMode ? "Your client projects" : "Work in progress",
        work.length
          ? work
              .slice(0, 5)
              .map(
                (s) =>
                  `<a class="list-row" href="#project/${s.project_id}"><span class="square-icon">${icon("projects")}</span><span class="grow"><strong>${esc(s.project?.title)}</strong><small>${esc(s.scope)}</small></span>${status(s.status)}${icon("arrow")}</a>`,
              )
              .join("")
          : empty(
              "Your work starts here",
              "Awarded projects will appear here.",
              link("Explore projects", "projects"),
            ),
        link(
          "View all",
          clientMode ? "projects/mine" : "projects/work",
          "text",
        ),
      )}${
        setupDone < setupSteps.length
          ? panel(
              "Get set up",
              `<div class="setup-progress" role="progressbar" aria-valuenow="${setupDone}" aria-valuemin="0" aria-valuemax="${setupSteps.length}" aria-label="Setup progress"><div style="width:${(setupDone / setupSteps.length) * 100}%"></div></div>` +
                setupSteps
                  .map(
                    ([label, done, cta], i) =>
                      `<div class="setup-step${done ? " is-done" : ""}"><span class="setup-marker">${done ? icon("check") : i + 1}</span><span class="grow">${esc(label)}</span>${!done ? cta : ""}</div>`,
                  )
                  .join(""),
            )
          : panel(
              "Next up",
              nextUp ||
                empty(
                  "You’re all caught up",
                  "Nothing needs your attention right now.",
                  "",
                  "check",
                ),
            )
      }</div>`
    );
  }
  if (route === "profile") {
    const me = await api(`/users/${c.user.id}`);
    return (
      heading(
        "Personal account",
        "Your profile",
        "Let people know what you do best.",
        link("Credentials & verification", "credentials") +
          link("Completed-work reputation", `trust-profile/${c.user.id}`) +
          button("Edit profile", "profile", "", "primary") +
          button("Sign out", "logout", "", "secondary"),
      ) +
      `<div class="profile-layout"><section class="panel profile-card"><span class="avatar large">${initials(c.user.full_name)}</span><h2>${esc(c.user.full_name)}</h2><p>${esc(c.user.email)}</p>${status(c.user.availability_status)}<hr><span class="muted">Hourly rate</span><strong class="large-number">${money(c.user.hourly_rate)} <small>/ hour</small></strong></section>${panel("Skills & experience", `<p class="muted">Your skills help clients and employers find the right fit.</p><div class="tags">${c.user.skills.length ? c.user.skills.map((s) => `<span>${esc(s)}</span>`).join("") : "<p>No skills added yet. Edit your profile to get started.</p>"}</div><hr><h3>Resume</h3>${me.resume ? `<p>${esc(me.resume.filename)}</p><div class="actions"><a class="btn secondary" href="/api/files/${me.resume.id}">Download resume</a>${button("Replace resume", "resume")}${button("Remove", "remove-resume", "", "danger")}</div>` : `<p class="muted">Add a resume so hiring managers can review it when you apply for a role.</p>${button("Add resume", "resume", "", "primary")}`}<hr><h3>Your organizations</h3>${c.memberships.length ? c.memberships.map((m) => `<a class="list-row" href="#organization/${m.org_id}"><span class="grow"><strong>${esc(m.organization.name)}</strong><small>${esc(m.organization.trade_focus || "Organization")}</small></span>${status(m.internal_role)}</a>`).join("") : empty("Better together", "Create an organization or apply for a role to join one.", link("Explore organizations", "organizations"), "people")}`)}${panel("Delete your account", `<p class="muted">Deleting your account permanently removes your profile, skills, resume, credentials, notifications and sign-in. You will not be able to sign back in.</p><p class="muted">Records other people depend on — awarded work, recorded hours, payments, lien waivers, signed documents, disputes and reviews — stay on WorkOrder with your personal details removed from them.</p><p class="muted">Close out work you have been awarded, release or refund any money you are holding, withdraw your payment balance and hand over organizations you own first.</p><div class="actions">${button("Delete account", "delete-account", "", "danger")}</div>`)}</div>`
    );
  }
  if (route === "people") {
    d.people = await paged("/users", page);
    const profiles = await Promise.all(
      d.people.map((u) => api(`/users/${u.id}`)),
    );
    d.people = d.people.map((u, i) => ({
      ...u,
      reputation: profiles[i].reputation,
    }));
    return (
      heading(
        "Professional network",
        "Find your people",
        "Explore skills and availability across the WorkOrder community.",
      ) +
      `<div class="cards">${d.people
        .map(
          (u) =>
            `<article class="card"><span class="avatar">${initials(u.full_name)}</span><h2>${esc(u.full_name)}</h2>${status(u.availability_status)}${reputationSummary(u.reputation)}<div class="tags">${u.skills
              .slice(0, 8)
              .map((s) => `<span>${esc(s)}</span>`)
              .join(
                "",
              )}</div><div class="card-footer"><strong>${money(u.hourly_rate)} <small>/ hour</small></strong>${button("View profile", "person", u.id)}${link("Credentials & reputation", `trust-profile/${u.id}`)}</div></article>`,
        )
        .join("")}</div>` +
      pager("people", page, d.people.length)
    );
  }
  if (route === "org-bids") {
    route = "projects";
    part = "bids";
  }
  if (route === "org-projects") {
    route = "projects";
    part = "work";
  }
  if (route === "org-jobs") {
    route = "jobs";
    part = "hiring";
  }
  if (route === "projects") {
    const view = ["mine", "work", "bids"].includes(part) ? part : "market";
    const workOrgId = c.org?.id || c.primaryOrg;
    const nav = tabs(
      [
        ["market", "Project market", "projects"],
        ["mine", "My client projects", "projects/mine"],
        [
          "work",
          "Assignments",
          workOrgId ? `org-projects/${workOrgId}` : "projects/work",
        ],
        ["bids", "Bids", workOrgId ? `org-bids/${workOrgId}` : "projects/bids"],
      ],
      view,
    );
    if ((view === "work" || view === "bids") && !workOrgId)
      return (
        heading(
          "Projects & collaboration",
          "Create an organization to see assigned work",
          "Assignments and bids are tracked per organization — even solo work goes through one.",
          button("Post a project", "project", "", "primary"),
        ) +
        nav +
        panel(
          "Get started",
          `<p class="muted">Create an organization — it can just be you — to bid on scopes and see what you’re assigned.</p>${button("Create organization", "organization", "", "primary")}`,
        )
      );
    const path = {
      market: "/projects",
      mine: "/me/projects",
      work: `/organizations/${workOrgId}/assignments`,
      bids: `/organizations/${workOrgId}/bids`,
    }[view];
    d.rows = await paged(path, page);
    const rows = d.rows;
    let body;
    if (view === "bids")
      body = rows.length
        ? panel(
            "Submitted bids",
            table(
              ["Project & scope", "Amount", "Status", "Actions"],
              rows.map((b) =>
                row([
                  `<a href="#project/${b.subdivision.project_id}"><strong>${esc(b.subdivision.project.title)}</strong><small>${esc(b.subdivision.scope)}</small></a>`,
                  money(b.amount),
                  status(b.status),
                  b.status === "pending"
                    ? button("Withdraw", "withdraw-bid", b.id)
                    : "—",
                ]),
              ),
            ),
          )
        : empty(
            "No bids yet",
            "Submit a bid on an open project subdivision.",
            link("Browse projects", "projects"),
          );
    else
      body = rows.length
        ? `<div class="cards">${rows.map((p) => `<article class="card"><div class="card-top"><span class="square-icon">${icon("projects")}</span>${status(p.status)}</div><h2><a href="#project/${view === "work" ? p.project_id : p.id}">${esc(view === "work" ? p.project.title : p.title)}</a></h2><p class="clamp">${esc(view === "work" ? p.scope : p.description || "Explore the project scope and available work.")}</p><div class="card-footer"><span class="muted">${esc(view === "work" ? p.awardedOrganization?.name || "Independent work" : p.clientOrganization?.name || p.client?.full_name || "Your project")}</span>${link("View project", `project/${view === "work" ? p.project_id : p.id}`)}</div></article>`).join("")}</div>`
        : empty(
            view === "mine"
              ? "Bring your project to life"
              : "No projects here yet",
            view === "mine"
              ? "Post a project and receive bids from independent workers and organizations."
              : "Browse the market for your next opportunity.",
            view === "mine"
              ? button("Post a project", "project", "", "primary")
              : link("Browse projects", "projects"),
          );
    return (
      heading(
        "Projects & collaboration",
        {
          market: "Find your next project",
          mine: "Projects you’re bringing to life",
          work: "Your assigned work",
          bids: "Your bids",
        }[view],
        "From the first bid to the final hour, keep every part of the work connected.",
        button("Post a project", "project", "", "primary"),
      ) +
      nav +
      body +
      pager(
        view === "bids"
          ? `org-bids/${workOrgId}`
          : view === "work"
            ? `org-projects/${workOrgId}`
            : view === "mine"
              ? "projects/mine"
              : "projects",
        page,
        d.rows.length,
      )
    );
  }
  if (route === "project") {
    const p = (d.project = await api(`/projects/${part}`));
    const own = p.client_user_id === c.user.id;
    const me = await api(`/users/${p.client_user_id}`);
    const clientOrg = p.client_org_id
      ? await api(`/organizations/${p.client_org_id}/profile`)
      : null;
    const allAssignments = await all("/me/assignments");
    const ordered = [];
    const visit = (parent = null, depth = 0, prefix = "") => {
      p.subdivisions
        .filter((s) => (s.parent_subdivision_id || null) === parent)
        .forEach((s, i) => {
          s.outline = prefix + (i + 1);
          s.depth = depth;
          ordered.push(s);
          visit(s.id, depth + 1, s.outline + ".");
        });
    };
    visit();
    const commercial = await all(`/billing?project_id=${p.id}`);
    const rootContracts = commercial.filter((s) => !s.parent_subdivision_id);
    const projectCosts = [];
    const subHtml = await Promise.all(
      ordered.map(async (s) => {
        const assigned = allAssignments.find((a) => a.id === s.id);
        const manager = s.awarded_org_id && c.manages(s.awarded_org_id);
        const canManage = own || s.awarded_user_id === c.user.id || manager;
        const parent = p.subdivisions.find(
          (a) => a.id === s.parent_subdivision_id,
        );
        const commission =
          own ||
          (parent &&
            active(parent) &&
            (parent.awarded_user_id === c.user.id ||
              c.manages(parent.awarded_org_id)));
        const bids = commission ? await all(`/subdivisions/${s.id}/bids`) : [];
        const cost =
          own || s.awarded_user_id === c.user.id || manager
            ? await api(`/subdivisions/${s.id}/costs`)
            : null;
        if (cost) projectCosts.push(cost);
        const finance = commercial.find((v) => v.id === s.id);
        return `<article class="panel subdivision ${s.depth ? "child-scope" : ""}" id="scope-${s.id}" data-subdivision="${s.id}"><div class="panel-heading"><div><span class="eyebrow">Scope ${s.outline} · ${esc(s.awardedOrganization?.name || s.awardedUser?.full_name || "Awaiting contractor")}</span><h2>${esc(s.scope)}</h2>${parent ? `<a class="muted" href="#project/${p.id}">↳ ${esc(parent.scope)}</a>` : ""}</div>${status(s.status)}</div><div class="actions">${commission && s.status === "open" ? button("Required credentials", "trust-requirements", s.id) : ""}${canManage && ["open", "awarded", "active"].includes(s.status) ? button("Add child scopes", "add-child", s.id) : ""}${s.status === "open" && !commission ? button("Submit a bid", "bid", s.id, "primary") : ""}${active(s) && assigned ? button("Log time", "log-time", s.id) : ""}${active(s) && assigned ? button("Use materials", "consume", s.id) : ""}${s.status === "awarded" && canManage ? button("Start work", "start-work", s.id) : ""}${active(s) && canManage ? button("Complete work", "complete-work", s.id) : ""}</div>${["awarded", "active", "completed"].includes(s.status) && (own || s.awarded_user_id === c.user.id || manager || (parent && (parent.awarded_user_id === c.user.id || c.manages(parent.awarded_org_id)))) ? `<div class="scope-commercial">${link("Scope billing & changes", `billing/${s.id}`)}</div>` : ""}${finance ? `<div class="cost-strip scope-contract"><span>Amended price · USD<strong>${money(Number(finance.awarded) + Number(finance.accepted_changes))}</strong><small>Award ${money(finance.awarded)} + changes ${money(finance.accepted_changes)}</small></span><span>Certified, unpaid · USD<strong>${money(Number(finance.certified) - Number(finance.paid) - Number(finance.released))}</strong><small>Approved amounts less releases and recorded payments</small></span><span>Funded · USD<strong>${money(finance.funded)}</strong><small>${money(finance.released)} released via Stripe</small></span></div>` : ""}${cost ? `<div class="cost-strip"><span>Labor <strong>${money(cost.labor_cost)}</strong></span><span>Materials <strong>${money(cost.material_cost)}</strong></span></div>` : ""}${cost?.labor?.length ? `<details class="labor-details"><summary>Labor by worker</summary>${laborTable(cost.labor)}</details>` : ""}${
          commission
            ? `<h3>Bids ${bids.length ? `(${bids.length})` : ""}</h3>${
                bids.length
                  ? table(
                      ["Bidder", "Amount", "Status", "Actions"],
                      bids.map((b) =>
                        row([
                          link(
                            b.organization?.name || b.user?.full_name,
                            `${b.bidding_org_id ? "trust-organization" : "trust-profile"}/${b.bidding_org_id || b.bidding_user_id}`,
                          ) +
                            reputationSummary(b.reputation) +
                            (s.required_credentials?.length &&
                            (b.standing.missing.length ||
                              b.standing.expired.length)
                              ? `<small class="muted">Missing a credential you're looking for — check before awarding.</small>`
                              : ""),
                          money(b.amount),
                          status(b.status),
                          `<div class="actions">${button("View bidder", b.bidding_org_id ? "trust-view-org" : "trust-view-user", b.bidding_org_id || b.bidding_user_id)}${b.status === "pending" && s.status === "open" ? button("Award bid", "award", b.id, "primary") : ""}</div>`,
                        ]),
                      ),
                    )
                  : '<p class="muted">No bids yet. Your open subdivision is visible on the project market.</p>'
              }`
            : ""
        }</article>`;
      }),
    );
    const showExplainer =
      p.subdivisions.length > 1 &&
      localStorage.getItem("workorder:dismissed:scope-explainer") !== "1";
    return (
      `<a class="back" href="#projects">← Projects</a>` +
      heading(
        `Posted by ${clientOrg ? clientOrg.name : me.full_name}`,
        p.title,
        p.description || "Project scope and execution",
        status(p.status),
      ) +
      (showExplainer
        ? `<div class="billing-notice"><span class="square-icon">${icon("projects")}</span><div class="grow"><strong>Each scope is bid, awarded, worked, and paid on its own.</strong><p>Child scopes (1.1, 1.2…) roll their hours and payments up into the parent scope above them.</p></div><button type="button" class="close" data-dismiss="scope-explainer" aria-label="Dismiss this note">×</button></div>`
        : "") +
      `<div class="actions space-bottom">${own && p.status === "open" ? button("Edit subdivisions", "subdivide", p.id) + button("Cancel project", "cancel-project", p.id, "danger") : ""}${commercial.length ? link("Lien waiver chain", `waivers/${p.id}`) : ""}</div>` +
      stats([
        ["Work packages", p.subdivisions.length, "Across all levels"],
        [
          "Open for bids",
          p.subdivisions.filter((s) => s.status === "open").length,
          "Ready for contractors",
        ],
        [
          "In progress",
          p.subdivisions.filter(active).length,
          "Awarded and active",
        ],
        [
          "Completed",
          p.subdivisions.filter((s) => s.status === "completed").length,
          "Delivered scopes",
        ],
      ]) +
      (rootContracts.length
        ? stats([
            [
              "Direct contract value · USD",
              money(
                rootContracts.reduce(
                  (n, s) => n + Number(s.awarded) + Number(s.accepted_changes),
                  0,
                ),
              ),
              "Root awards + accepted changes; excludes nested subcontracts",
            ],
            [
              "Certified, unpaid · USD",
              money(
                rootContracts.reduce(
                  (n, s) =>
                    n +
                    Number(s.certified) -
                    Number(s.paid) -
                    Number(s.released),
                  0,
                ),
              ),
              "Approved direct-contract applications less recorded payments",
            ],
            [
              "Payments recorded · USD",
              money(rootContracts.reduce((n, s) => n + Number(s.paid), 0)),
              "External direct-contract payments, net of reversals",
            ],
          ])
        : "") +
      panel(
        "Delivery progress",
        `<progress class="project-progress" max="${p.subdivisions.length || 1}" value="${p.subdivisions.filter((s) => s.status === "completed").length}" aria-label="Completed work packages"></progress><p class="muted">Expand your delivery plan with child scopes. Each package has its own contractor, bids and costs.</p>`,
      ) +
      (projectCosts.length
        ? panel(
            own
              ? "Project labor & materials"
              : "Your managed labor & materials",
            `<div class="cost-strip"><span>Labor <strong>${money(projectCosts.reduce((n, v) => n + Number(v.labor_cost), 0))}</strong></span><span>Materials <strong>${money(projectCosts.reduce((n, v) => n + Number(v.material_cost), 0))}</strong></span></div><p class="muted">Actual costs from recorded hours at saved worker rates. Each work package is counted once.</p>`,
          )
        : "") +
      subHtml.join("")
    );
  }
  if (route === "jobs") {
    const view = ["hiring", "applications"].includes(part) ? part : "board";
    const path =
      view === "board"
        ? "/jobs"
        : view === "applications"
          ? "/applications"
          : c.org
            ? orgPath(c) + "/jobs"
            : "/me/jobs";
    d.rows = await paged(path, page);
    let body;
    if (view === "applications")
      body = d.rows.length
        ? panel(
            "Your applications",
            table(
              ["Role", "Employer", "Pay", "Status", "Actions"],
              d.rows.map((a) =>
                row([
                  esc(a.posting.title),
                  esc(
                    a.posting.organization?.name || a.posting.poster?.full_name,
                  ),
                  paySummary(a),
                  status(a.status),
                  `<div class="actions">${button("Pay discussion", "pay-history", a.id)}${["pending", "offered"].includes(a.status) && a.posting.status === "open" ? button("Negotiate pay", "counter-offer", a.id) : ""}${a.status === "offered" ? button("Accept offer", "accept-offer", a.id, "primary") : ""}${["pending", "offered"].includes(a.status) ? button("Withdraw", "withdraw-application", a.id) : "—"}</div>`,
                ]),
              ),
            ),
          )
        : empty(
            "Your next role is out there",
            "Apply for a position, then review offers here.",
            link("Browse jobs", "jobs"),
            "jobs",
          );
    else
      body = d.rows.length
        ? `<div class="cards">${d.rows.map((j) => `<article class="card"><div class="card-top"><span class="square-icon">${icon("jobs")}</span>${status(j.status)}</div><p class="eyebrow">${esc(j.organization?.name || j.poster?.full_name)}</p><h2>${esc(j.title)}</h2><p class="pay-highlight">${payLabel(j.hourly_rate)}</p><p class="clamp">${esc(j.description)}</p><div class="card-footer"><span class="muted">${j.posted_by_org_id ? "Organization role" : "Personal hire"}</span>${link(view === "hiring" ? "Manage posting" : "View role", `job/${j.id}`)}</div></article>`).join("")}</div>`
        : empty(
            view === "hiring" ? "Build your team" : "No open roles yet",
            view === "hiring"
              ? "Post a role and invite applicants to join your organization or work with you."
              : "Check back for new opportunities.",
            button("Post a job", "job", "", "primary"),
            "jobs",
          );
    return (
      heading(
        "Employment & opportunities",
        view === "hiring"
          ? "Find the right people"
          : view === "applications"
            ? "Your applications"
            : "Find work that fits",
        "A new role, a growing team, or an extra pair of hands.",
        button("Post a job", "job", "", "primary"),
      ) +
      tabs(
        [
          ["board", "Job board", "jobs"],
          [
            "hiring",
            c.org ? "Organization hiring" : "My hiring",
            "jobs/hiring",
          ],
          ["applications", "My applications", "jobs/applications"],
        ],
        view,
      ) +
      body +
      pager(
        c.org ? `org-jobs/${c.org.id}` : `jobs/${view === "board" ? "" : view}`,
        page,
        d.rows.length,
      )
    );
  }
  if (route === "job") {
    const j = (d.job = await api(`/jobs/${part}`));
    const manage = j.posted_by_org_id
      ? c.manages(j.posted_by_org_id)
      : j.posted_by_user_id === c.user.id;
    const applications = manage
      ? await all(`/jobs/${j.id}/applications`)
      : (await all("/applications")).filter((a) => a.job_posting_id === j.id);
    d.applicants = applications;
    const member = c.memberships.some((m) => m.org_id === j.posted_by_org_id);
    return (
      '<a class="back" href="#jobs">← Employment</a>' +
      heading(
        "Employment opportunity",
        j.title,
        "A good fit starts with a conversation.",
        status(j.status),
      ) +
      panel(
        "About this role",
        `<p class="pay-highlight">${payLabel(j.hourly_rate)} <small>Advertised pay · open to negotiation</small></p><p class="preserve">${esc(j.description)}</p><div class="actions">${manage && j.status === "open" ? button("Close posting", "close-job", j.id, "danger") : ""}${!manage && !member && !applications.length && j.status === "open" ? button("Apply for this role", "apply", j.id, "primary") : ""}${!manage && applications.length ? `<p>Your application is ${status(applications[0].status)}. ${link("View applications", "jobs/applications")}</p>` : ""}${member && !manage ? '<p class="muted">You already belong to this organization.</p>' : ""}</div>`,
      ) +
      (manage
        ? panel(
            "Applicants",
            applications.length
              ? table(
                  ["Applicant", "Skills", "Pay", "Status", "Actions"],
                  applications.map((a) =>
                    row([
                      `<strong>${esc(a.applicant.full_name)}</strong><small>${money(a.applicant.hourly_rate)} / hour</small>`,
                      esc(a.applicant.skills.join(", ") || "No skills listed"),
                      paySummary(a),
                      status(a.status),
                      `<div class="actions">${button("View profile", "trust-view-user", a.applicant.id)}${button("Pay discussion", "pay-history", a.id)}${["pending", "offered"].includes(a.status) && j.status === "open" ? button(a.status === "pending" ? "Make offer" : "Revise offer", "offer", a.id, "primary") + button("Reject", "reject", a.id, "danger") : ""}</div>`,
                    ]),
                  ),
                )
              : empty(
                  "No applicants yet",
                  "Your open posting is visible on the employment board.",
                ),
          )
        : "")
    );
  }
  if (route === "organizations") {
    const profiles = await Promise.all(
      c.memberships.map((m) => api(`/organizations/${m.org_id}/profile`)),
    );
    const reputations = new Map(profiles.map((p) => [p.id, p.reputation]));
    return (
      heading(
        "Your organizations",
        "Better work, together",
        "Create an organization, or join one by accepting an employment offer.",
        button("Create organization", "organization", "", "primary"),
      ) +
      (c.memberships.length
        ? `<div class="cards">${c.memberships.map((m) => `<article class="card"><div class="card-top"><span class="avatar">${initials(m.organization.name)}</span>${status(m.internal_role)}</div><h2>${esc(m.organization.name)}</h2>${typeBadges(m.organization.organization_types)}${reputationSummary(reputations.get(m.org_id))}<p>${esc(m.organization.trade_focus || "A shared place for your team and its work.")}</p><div class="card-footer">${link("View organization", `organization/${m.org_id}`)}${link("Credentials & reputation", `trust-organization/${m.org_id}`)}${c.manages(m.org_id) ? link("Control panel", `organization/${m.org_id}`) : ""}</div></article>`).join("")}</div>`
        : empty(
            "Start something together",
            "Create an organization to bid on projects, hire people, and share resources.",
            button("Create organization", "organization", "", "primary"),
            "people",
          ))
    );
  }
  if (route === "organization") {
    const membership = c.memberships.find((m) => m.org_id === Number(part));
    if (!membership) throw new Error("You do not belong to this organization.");
    d.members = await all(`/organizations/${part}/members`);
    d.organization = membership.organization;
    d.roles = await all(`/organizations/${part}/roles`);
    const manage = c.manages(Number(part));
    const report = manage
      ? await api(
          `/organizations/${part}/dashboard?from=${c.currentWeek.from}&to=${c.currentWeek.to}`,
        )
      : null;
    return (
      '<a class="back" href="#organizations">← Organizations</a>' +
      typeBadges(membership.organization.organization_types) +
      heading(
        "Organization",
        membership.organization.name,
        membership.organization.trade_focus ||
          "People, skills, and shared work.",
        c.manages(Number(part))
          ? button("Edit organization", "edit-organization", part, "primary")
          : "",
      ) +
      panel(
        "Your access",
        `<div class="actions">${link("Field work", "field")}${link("Shared inventory", `inventory/${part}`)}${link("Billing", "billing")}</div><p class="muted">Log time, use shared materials, and review billing for this organization’s work.</p>`,
      ) +
      (manage
        ? stats([
            ["Team members", d.members.length, "Your organization"],
            [
              "Hours this week",
              Number(report.hours).toFixed(2),
              "Team timesheets",
            ],
            ["Labor cost", money(report.labor_cost), "This week"],
            ["Material cost", money(report.material_cost), "This week"],
          ]) +
          panel(
            "Organization control panel",
            `<div class="actions">${button("Post a job", "job", "", "primary")}${link("Manage hiring", `org-jobs/${part}`)}${link("Assigned projects", `org-projects/${part}`)}${link("Organization bids", `org-bids/${part}`)}${link("Team reports", `time/${part}`)}</div><p class="muted">Manage your organization’s hiring, resources and project delivery from one place.</p>`,
          )
        : "") +
      (manage
        ? panel(
            "Company roles & base pay",
            d.roles.length
              ? `<div class="cards">${d.roles.map((r) => `<article class="card"><h3>${esc(r.name)}</h3><p class="pay-highlight">${payLabel(r.hourly_rate)}</p><p class="preserve">${esc(r.description)}</p><div class="tags">${r.skills.map((skill) => `<span>${esc(skill)}</span>`).join("")}</div>${button("Edit company role", "company-role", r.id)}</article>`).join("")}</div>`
              : empty(
                  "Define your company roles",
                  "Set responsibilities, required skills and base hourly pay for each role.",
                  "",
                  "people",
                ),
            button("Create company role", "company-role", "", "primary"),
          )
        : "") +
      panel(
        "Team roster",
        table(
          [
            "Member",
            "Access",
            "Company role",
            "Hourly pay",
            "Joined",
            "Actions",
          ],
          d.members.map((m) =>
            row([
              `<strong>${esc(m.user.full_name)}</strong><small>${esc(m.user.skills.join(", "))}</small>`,
              status(m.internal_role),
              esc(m.companyRole?.name || "Unassigned"),
              `<strong>${payLabel(m.hourly_rate ?? m.companyRole?.hourly_rate ?? m.user.hourly_rate)}</strong><small>${m.hourly_rate != null ? "Individual agreement" : m.companyRole ? "Role base pay" : "Profile rate"}</small>`,
              dateLabel(m.joined_at),
              `<div class="actions">${manage ? button("Role & pay", "member-pay", m.user_id) : ""}${membership.internal_role === "owner" && m.internal_role !== "owner" ? button("Change access", "member-role", m.user_id) : ""}</div>`,
            ]),
          ),
        ),
      ) +
      (manage && report.entries.length
        ? panel(
            "Labor this week",
            laborTable(
              report.entries,
              (id) => d.members.find((m) => m.user_id === id)?.user.full_name,
            ),
            link("Detailed report", `time/${part}`),
          )
        : "") +
      `<div class="actions space-top">${link("View shared inventory", `inventory/${part}`)}${link("Find assigned work", `org-projects/${part}`)}</div>`
    );
  }
  if (route === "inventory") {
    const orgId = Number(part) || c.org?.id || c.primaryOrg;
    if (!orgId)
      return (
        heading(
          "Inventory",
          "Create an organization to track inventory",
          "Tools and materials are tracked per organization — even solo work goes through one, so nothing gets lost between jobs.",
        ) +
        panel(
          "Get started",
          `<p class="muted">Create an organization — it can just be you — to start tracking tools and materials.</p>${button("Create organization", "organization", "", "primary")}`,
        )
      );
    d.inventoryOrg = orgId;
    const canEdit = c.manages(orgId);
    d.items = await paged(`/organizations/${orgId}/inventory`, page);
    return (
      heading(
        organizationName(c, orgId),
        "Inventory",
        "Keep track of what you have and where it goes.",
        canEdit ? button("Add inventory", "inventory", "", "primary") : "",
      ) +
      (d.items.length
        ? panel(
            "Tools & materials",
            table(
              ["Item", "Available stock", "Unit cost", "Actions"],
              d.items.map((i) =>
                row([
                  `<strong>${esc(i.item_name)}</strong><small>${esc(i.unit)}</small>`,
                  `<strong class="${i.stock === 0 ? "low-stock" : ""}">${i.stock}</strong>`,
                  money(i.unit_cost),
                  `<div class="actions">${canEdit ? button("Receive stock", "receipt", i.id) + button("History", "ledger", i.id) : ""}${button("Use on project", "consume-item", i.id)}</div>`,
                ]),
              ),
            ),
          )
        : empty(
            "A place for every resource",
            "Add your tools and materials, then record their use on awarded work.",
            canEdit ? button("Add inventory", "inventory", "", "primary") : "",
            "inventory",
          )) +
      pager(`inventory/${orgId || ""}`, page, d.items.length)
    );
  }
  if (route === "time") {
    const org = c.org && part !== "personal";
    const range = c.range;
    const report = await api(
      org
        ? `${orgPath(c)}/dashboard?from=${range.from}&to=${range.to}`
        : `/time?from=${range.from}&to=${range.to}`,
    );
    d.assignments = await all("/me/assignments");
    d.entries = org
      ? report.entries
      : await api(`/time/entries?from=${range.from}&to=${range.to}`);
    let members = [];
    if (org) members = await all(orgPath(c) + "/members");
    const titles = new Map(
      d.assignments.map((s) => [s.id, assignmentTitle(s)]),
    );
    const person = (id) =>
      members.find((m) => m.user_id === id)?.user.full_name || `Member ${id}`;
    return (
      heading(
        org ? c.org.name : "Personal time",
        org ? "Team time & costing" : "Make every hour count",
        org
          ? "Hours flow here directly from your team’s personal timesheets."
          : "Log your own hours across independent and organization work.",
        button("Log time", "log-time", "", "primary"),
      ) +
      `<form id="range-form" class="range-form">${field("From", "from", "date", range.from, "required")}${field("To", "to", "date", range.to, "required")}<button class="btn secondary">Apply dates</button>${org ? link("My personal time", "time/personal") : ""}</form>` +
      stats([
        [
          "Total hours",
          Number(report.hours).toFixed(2),
          `${dateLabel(range.from)} – ${dateLabel(range.to)}`,
        ],
        [
          "Labor cost",
          money(report.labor_cost),
          "At rates saved with each entry",
        ],
        ...(org
          ? [
              [
                "Material cost",
                money(report.material_cost),
                "Materials consumed during this period",
              ],
            ]
          : []),
      ]) +
      panel("Log time", timeEntryForm(c)) +
      (!org
        ? panel(
            "Daily grid",
            d.entries.length
              ? timeGrid()
              : `<p class="muted">Your grid appears here once you log an entry.</p><details class="labor-details"><summary>Show the empty grid</summary>${timeGrid()}</details>`,
          )
        : "") +
      panel(
        org ? "Team timesheets" : "Time entries",
        d.entries.length
          ? table(
              org
                ? [
                    "Date",
                    "Member",
                    "Work",
                    "Clock times",
                    "Hours",
                    "Hourly rate",
                    "Labor cost",
                  ]
                : [
                    "Date",
                    "Work",
                    "Clock times",
                    "Hours",
                    "Hourly rate",
                    "Labor cost",
                    "Note",
                    "Actions",
                  ],
              d.entries.map((e) =>
                row(
                  org
                    ? [
                        dateLabel(e.date),
                        esc(person(e.user_id)),
                        esc(
                          titles.get(e.subdivision_id) ||
                            `Subdivision ${e.subdivision_id}`,
                        ),
                        e.start_time
                          ? `${esc(e.start_time.slice(0, 5))} – ${esc(e.end_time.slice(0, 5))}`
                          : "Times not recorded",
                        esc(e.hours),
                        money(e.hourly_rate),
                        money(e.labor_cost),
                      ]
                    : [
                        dateLabel(e.date),
                        `<strong>${esc(titles.get(e.subdivision_id) || `Subdivision ${e.subdivision_id}`)}</strong><small>${e.org_id ? esc(organizationName(c, e.org_id)) : "Independent work"}</small>`,
                        e.start_time
                          ? `${esc(e.start_time.slice(0, 5))} – ${esc(e.end_time.slice(0, 5))}`
                          : "Times not recorded",
                        esc(e.hours),
                        money(e.hourly_rate),
                        money(Number(e.hours) * Number(e.hourly_rate)),
                        esc(e.note || "—"),
                        d.assignments.some(
                          (s) => s.id === e.subdivision_id && active(s),
                        )
                          ? `<div class="actions">${button("Edit", "edit-time", e.id)}${button("Delete", "delete-time", e.id, "danger")}</div>`
                          : "Completed work",
                      ],
                ),
              ),
            )
          : empty(
              "No hours in this period",
              "Log time against awarded work to build your timesheet.",
              button("Log time", "log-time", "", "primary"),
              "time",
            ),
      )
    );
  }
  return heading(
    "Workspace",
    "Page not found",
    "Choose a destination from the sidebar.",
    link("Go to overview", "overview", "primary"),
  );
}
