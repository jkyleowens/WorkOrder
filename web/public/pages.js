import { api, all } from "./api.js";
import {
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
export async function renderPage(c, route, part, page = 0) {
  c.data = {};
  const d = c.data;
  if (route === "overview") {
    const [projects, assignments, applications, inventory, report] =
      await Promise.all([
        all("/me/projects"),
        all("/me/assignments"),
        all("/applications"),
        all(c.org ? orgPath(c) + "/inventory" : "/inventory"),
        api(
          c.org
            ? `${orgPath(c)}/dashboard?from=${c.currentWeek.from}&to=${c.currentWeek.to}`
            : `/time/week?date=${today()}`,
        ),
      ]);
    const clientMode = c.context.mode === "client";
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
      `<section class="welcome-band"><div><span class="eyebrow">${c.org ? "Working together" : "Make room for good work"}</span><h2>${c.org ? "Keep everyone moving in the same direction." : "Your next chapter starts here."}</h2><p>${c.org ? "Review assignments, coordinate your roster, and see where resources go." : "Find a project, build your team, or bring an idea to life."}</p><div class="actions">${link("Explore projects", "projects", "primary")}${link(c.org ? "Manage hiring" : "Find a job", c.org ? "jobs/hiring" : "jobs")}</div></div><div class="workmark" aria-hidden="true"><span>W</span><small>YOUR WORK.<br>IN ORDER.</small></div></section>` +
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
          c.org ? "Shared organization stock" : "Your tools and materials",
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
      )}${panel("Next steps", `<a class="list-row" href="#jobs/applications"><span class="square-icon">${icon("jobs")}</span><span class="grow"><strong>${applications.filter((a) => a.status === "offered").length} offers to review</strong><small>Respond to employers and join a team.</small></span>${icon("arrow")}</a><a class="list-row" href="#profile"><span class="square-icon">${icon("profile")}</span><span class="grow"><strong>Make your profile yours</strong><small>Add skills, availability, and your hourly rate.</small></span>${icon("arrow")}</a><a class="list-row" href="#organizations"><span class="square-icon">${icon("people")}</span><span class="grow"><strong>Your people, in one place</strong><small>Create or manage an organization.</small></span>${icon("arrow")}</a>`)}</div>`
    );
  }
  if (route === "profile")
    return (
      heading(
        "Personal account",
        "Your profile",
        "Let people know what you do best.",
        button("Edit profile", "profile", "", "primary") +
          button("Sign out", "logout", "", "secondary"),
      ) +
      `<div class="profile-layout"><section class="panel profile-card"><span class="avatar large">${initials(c.user.full_name)}</span><h2>${esc(c.user.full_name)}</h2><p>${esc(c.user.email)}</p>${status(c.user.availability_status)}<hr><span class="muted">Hourly rate</span><strong class="large-number">${money(c.user.hourly_rate)} <small>/ hour</small></strong></section>${panel("Skills & experience", `<p class="muted">Your skills help clients and employers find the right fit.</p><div class="tags">${c.user.skills.length ? c.user.skills.map((s) => `<span>${esc(s)}</span>`).join("") : "<p>No skills added yet. Edit your profile to get started.</p>"}</div><hr><h3>Your organizations</h3>${c.memberships.length ? c.memberships.map((m) => `<a class="list-row" href="#organization/${m.org_id}"><span class="grow"><strong>${esc(m.organization.name)}</strong><small>${esc(m.organization.trade_focus || "Organization")}</small></span>${status(m.internal_role)}</a>`).join("") : empty("Better together", "Create an organization or apply for a role to join one.", link("Explore organizations", "organizations"))}`)}</div>`
    );
  if (route === "people") {
    d.people = await paged("/users", page);
    return (
      heading(
        "Professional network",
        "Find your people",
        "Explore skills and availability across the WorkOrder community.",
      ) +
      `<div class="cards">${d.people
        .map(
          (u) =>
            `<article class="card"><span class="avatar">${initials(u.full_name)}</span><h2>${esc(u.full_name)}</h2>${status(u.availability_status)}<div class="tags">${u.skills
              .slice(0, 8)
              .map((s) => `<span>${esc(s)}</span>`)
              .join(
                "",
              )}</div><div class="card-footer"><strong>${money(u.hourly_rate)} <small>/ hour</small></strong>${button("View profile", "person", u.id)}</div></article>`,
        )
        .join("")}</div>` +
      pager("people", page, d.people.length)
    );
  }
  if (route === "projects") {
    const view = ["mine", "work", "bids"].includes(part) ? part : "market";
    const nav = tabs(
      [
        ["market", "Project market", "projects"],
        ["mine", "My client projects", "projects/mine"],
        ["work", "My assignments", "projects/work"],
        ["bids", c.org ? "Organization bids" : "My bids", "projects/bids"],
      ],
      view,
    );
    const path = {
      market: "/projects",
      mine: "/me/projects",
      work: c.org ? orgPath(c) + "/assignments" : "/me/assignments",
      bids: c.org ? orgPath(c) + "/bids" : "/bids",
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
        ? `<div class="cards">${rows.map((p) => `<article class="card"><div class="card-top"><span class="square-icon">${icon("projects")}</span>${status(p.status)}</div><h2><a href="#project/${view === "work" ? p.project_id : p.id}">${esc(view === "work" ? p.project.title : p.title)}</a></h2><p class="clamp">${esc(view === "work" ? p.scope : p.description || "Explore the project scope and available work.")}</p><div class="card-footer"><span class="muted">${esc(view === "work" ? p.awardedOrganization?.name || "Independent work" : p.client?.full_name || "Your project")}</span>${link("View project", `project/${view === "work" ? p.project_id : p.id}`)}</div></article>`).join("")}</div>`
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
          bids: c.org ? "Your organization’s bids" : "Your bids",
        }[view],
        "From the first bid to the final hour, keep every part of the work connected.",
        button("Post a project", "project", "", "primary"),
      ) +
      nav +
      body +
      pager(`projects/${view === "market" ? "" : view}`, page, d.rows.length)
    );
  }
  if (route === "project") {
    const p = (d.project = await api(`/projects/${part}`));
    const own = p.client_user_id === c.user.id;
    const me = await api(`/users/${p.client_user_id}`);
    const allAssignments = await all("/me/assignments");
    const subHtml = await Promise.all(
      p.subdivisions.map(async (s) => {
        const assigned = allAssignments.find((a) => a.id === s.id);
        const manager = s.awarded_org_id && c.manages(s.awarded_org_id);
        const canManage = own || s.awarded_user_id === c.user.id || manager;
        const bids = own ? await all(`/subdivisions/${s.id}/bids`) : [];
        const cost =
          own || s.awarded_user_id === c.user.id || manager
            ? await api(`/subdivisions/${s.id}/costs`)
            : null;
        return `<article class="panel subdivision" data-subdivision="${s.id}"><div class="panel-heading"><div><span class="eyebrow">Subdivision ${s.sequence}</span><h2>${esc(s.scope)}</h2></div>${status(s.status)}</div><div class="actions">${s.status === "open" && !own ? button("Submit a bid", "bid", s.id, "primary") : ""}${active(s) && assigned ? button("Log time", "log-time", s.id) : ""}${active(s) && assigned ? button("Use materials", "consume", s.id) : ""}${s.status === "awarded" && canManage ? button("Start work", "start-work", s.id) : ""}${active(s) && canManage ? button("Complete work", "complete-work", s.id) : ""}</div>${cost ? `<div class="cost-strip"><span>Labor <strong>${money(cost.labor_cost)}</strong></span><span>Materials <strong>${money(cost.material_cost)}</strong></span></div>` : ""}${
          own
            ? `<h3>Bids ${bids.length ? `(${bids.length})` : ""}</h3>${
                bids.length
                  ? table(
                      ["Bidder", "Amount", "Status", ""],
                      bids.map((b) =>
                        row([
                          esc(b.organization?.name || b.user?.full_name),
                          money(b.amount),
                          status(b.status),
                          b.status === "pending" && s.status === "open"
                            ? button("Award bid", "award", b.id, "primary")
                            : "—",
                        ]),
                      ),
                    )
                  : '<p class="muted">No bids yet. Your open subdivision is visible on the project market.</p>'
              }`
            : ""
        }</article>`;
      }),
    );
    return (
      `<a class="back" href="#projects">← Projects</a>` +
      heading(
        `Posted by ${me.full_name}`,
        p.title,
        p.description || "Project scope and execution",
        status(p.status),
      ) +
      `<div class="actions space-bottom">${own && p.status === "open" ? button("Edit subdivisions", "subdivide", p.id) + button("Cancel project", "cancel-project", p.id, "danger") : ""}</div>` +
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
              ["Role", "Employer", "Status", "Actions"],
              d.rows.map((a) =>
                row([
                  esc(a.posting.title),
                  esc(
                    a.posting.organization?.name || a.posting.poster?.full_name,
                  ),
                  status(a.status),
                  `<div class="actions">${a.status === "offered" ? button("Accept offer", "accept-offer", a.id, "primary") : ""}${["pending", "offered"].includes(a.status) ? button("Withdraw", "withdraw-application", a.id) : "—"}</div>`,
                ]),
              ),
            ),
          )
        : empty(
            "Your next role is out there",
            "Apply for a position, then review offers here.",
            link("Browse jobs", "jobs"),
          );
    else
      body = d.rows.length
        ? `<div class="cards">${d.rows.map((j) => `<article class="card"><div class="card-top"><span class="square-icon">${icon("jobs")}</span>${status(j.status)}</div><p class="eyebrow">${esc(j.organization?.name || j.poster?.full_name)}</p><h2>${esc(j.title)}</h2><p class="clamp">${esc(j.description)}</p><div class="card-footer"><span class="muted">${j.posted_by_org_id ? "Organization role" : "Personal hire"}</span>${link(view === "hiring" ? "Manage posting" : "View role", `job/${j.id}`)}</div></article>`).join("")}</div>`
        : empty(
            view === "hiring" ? "Build your team" : "No open roles yet",
            view === "hiring"
              ? "Post a role and invite applicants to join your organization or work with you."
              : "Check back for new opportunities.",
            button("Post a job", "job", "", "primary"),
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
      pager(`jobs/${view === "board" ? "" : view}`, page, d.rows.length)
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
        `<p class="preserve">${esc(j.description)}</p><div class="actions">${manage && j.status === "open" ? button("Close posting", "close-job", j.id, "danger") : ""}${!manage && !member && !applications.length && j.status === "open" ? button("Apply for this role", "apply", j.id, "primary") : ""}${!manage && applications.length ? `<p>Your application is ${status(applications[0].status)}. ${link("View applications", "jobs/applications")}</p>` : ""}${member && !manage ? '<p class="muted">You already belong to this organization.</p>' : ""}</div>`,
      ) +
      (manage
        ? panel(
            "Applicants",
            applications.length
              ? table(
                  ["Applicant", "Skills", "Status", "Actions"],
                  applications.map((a) =>
                    row([
                      `<strong>${esc(a.applicant.full_name)}</strong><small>${money(a.applicant.hourly_rate)} / hour</small>`,
                      esc(a.applicant.skills.join(", ") || "No skills listed"),
                      status(a.status),
                      ["pending", "offered"].includes(a.status) &&
                      j.status === "open"
                        ? `<div class="actions">${a.status === "pending" ? button("Make offer", "offer", a.id, "primary") : ""}${button("Reject", "reject", a.id, "danger")}</div>`
                        : "—",
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
  if (route === "organizations")
    return (
      heading(
        "Your organizations",
        "Better work, together",
        "Create an organization, or join one by accepting an employment offer.",
        button("Create organization", "organization", "", "primary"),
      ) +
      (c.memberships.length
        ? `<div class="cards">${c.memberships.map((m) => `<article class="card"><div class="card-top"><span class="avatar">${initials(m.organization.name)}</span>${status(m.internal_role)}</div><h2>${esc(m.organization.name)}</h2><p>${esc(m.organization.trade_focus || "A shared place for your team and its work.")}</p><div class="card-footer">${link("View organization", `organization/${m.org_id}`)}${c.manages(m.org_id) ? button("Switch context", "switch-org", m.org_id) : ""}</div></article>`).join("")}</div>`
        : empty(
            "Start something together",
            "Create an organization to bid on projects, hire people, and share resources.",
            button("Create organization", "organization", "", "primary"),
          ))
    );
  if (route === "organization") {
    const membership = c.memberships.find((m) => m.org_id === Number(part));
    if (!membership) throw new Error("You do not belong to this organization.");
    d.members = await all(`/organizations/${part}/members`);
    d.organization = membership.organization;
    return (
      '<a class="back" href="#organizations">← Organizations</a>' +
      heading(
        "Organization",
        membership.organization.name,
        membership.organization.trade_focus ||
          "People, skills, and shared work.",
        c.manages(Number(part))
          ? button("Open organization console", "switch-org", part, "primary")
          : "",
      ) +
      panel(
        "Team roster",
        table(
          ["Member", "Role", "Joined", ""],
          d.members.map((m) =>
            row([
              `<strong>${esc(m.user.full_name)}</strong><small>${esc(m.user.skills.join(", "))}</small>`,
              status(m.internal_role),
              dateLabel(m.joined_at),
              membership.internal_role === "owner" &&
              m.internal_role !== "owner"
                ? button("Change role", "member-role", m.user_id)
                : "—",
            ]),
          ),
        ),
      ) +
      `<div class="actions space-top">${link("View shared inventory", `inventory/${part}`)}${link("Find assigned work", "projects/work")}</div>`
    );
  }
  if (route === "inventory") {
    const orgId = Number(part) || c.org?.id;
    d.inventoryOrg = orgId;
    const canEdit = !orgId || c.manages(orgId);
    d.items = await paged(
      orgId ? `/organizations/${orgId}/inventory` : "/inventory",
      page,
    );
    return (
      heading(
        orgId ? organizationName(c, orgId) : "Personal resources",
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
    const days = Array.from({ length: 7 }, (_, i) => {
      const dt = new Date(range.from + "T12:00:00");
      dt.setDate(dt.getDate() + i);
      return dt.toISOString().slice(0, 10);
    }).filter((dt) => dt <= range.to);
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
      (!org
        ? panel(
            "Daily grid",
            `<p class="muted">${days.length === 7 ? "First seven days of your selected period" : "Your selected period"}</p><div class="week-grid">${days
              .map((dt) => {
                const total = d.entries
                  .filter((e) => e.date === dt)
                  .reduce((n, e) => n + Number(e.hours), 0);
                return `<div class="day ${dt === today() ? "today" : ""}"><span>${new Date(dt + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" })}</span><strong>${total.toFixed(2)}<small> h</small></strong><progress max="24" value="${total}" aria-label="${esc(dt)} hours"></progress><small>${dateLabel(dt)}</small></div>`;
              })
              .join("")}</div>`,
          )
        : "") +
      panel(
        org ? "Team timesheets" : "Time entries",
        d.entries.length
          ? table(
              org
                ? ["Date", "Member", "Work", "Hours", "Labor cost"]
                : ["Date", "Work", "Hours", "Note", "Actions"],
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
                        esc(e.hours),
                        money(e.labor_cost),
                      ]
                    : [
                        dateLabel(e.date),
                        `<strong>${esc(titles.get(e.subdivision_id) || `Subdivision ${e.subdivision_id}`)}</strong><small>${e.org_id ? esc(organizationName(c, e.org_id)) : "Independent work"}</small>`,
                        esc(e.hours),
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
