const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icons = {
  grid: "▦",
  projects: "▤",
  inventory: "▧",
  time: "◷",
  employees: "♙",
  arrow: "↗",
};
const date = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
const seed = () => ({
  version: 1,
  projects: [
    {
      id: "p1",
      name: "Workshop expansion",
      description: "A better space for our next chapter.",
      category: "Operations",
      due: date(12),
      status: "In progress",
      owner: "Alex Morgan",
      tasks: [
        { name: "Finalize floor plan", done: true },
        { name: "Order workbenches", done: true },
        { name: "Install electrical outlets", done: false },
        { name: "Set up assembly stations", done: false },
      ],
    },
    {
      id: "p2",
      name: "Spring product collection",
      description: "Bring the new collection from concept to craft.",
      category: "Production",
      due: date(6),
      status: "In progress",
      owner: "Jamie Chen",
      tasks: [
        { name: "Approve prototypes", done: true },
        { name: "Source materials", done: true },
        { name: "Build first production run", done: false },
      ],
    },
    {
      id: "p3",
      name: "Inventory reorganization",
      description: "Everything in its right place.",
      category: "Operations",
      due: date(20),
      status: "Planning",
      owner: "Taylor Brooks",
      tasks: [
        { name: "Audit current materials", done: true },
        { name: "Label storage bins", done: false },
        { name: "Update locations", done: false },
      ],
    },
    {
      id: "p4",
      name: "Safety & equipment review",
      description: "Keep our people and our equipment ready.",
      category: "Maintenance",
      due: date(-2),
      status: "Completed",
      owner: "Sam Rivera",
      tasks: [
        { name: "Inspect equipment", done: true },
        { name: "Team safety briefing", done: true },
      ],
    },
  ],
  inventory: [
    {
      id: "i1",
      name: "White oak boards",
      sku: "WD-001",
      category: "Lumber",
      quantity: 42,
      minimum: 20,
      unit: "boards",
      location: "Warehouse A · Rack 02",
      cost: 28,
    },
    {
      id: "i2",
      name: "Wood screws · 40 mm",
      sku: "HW-014",
      category: "Hardware",
      quantity: 180,
      minimum: 200,
      unit: "pcs",
      location: "Workshop · Bin 12",
      cost: 0.12,
    },
    {
      id: "i3",
      name: "Natural wood finish",
      sku: "FN-008",
      category: "Finishes",
      quantity: 6,
      minimum: 10,
      unit: "cans",
      location: "Warehouse A · Shelf 04",
      cost: 24,
    },
    {
      id: "i4",
      name: "Birch plywood · 18 mm",
      sku: "WD-006",
      category: "Lumber",
      quantity: 24,
      minimum: 10,
      unit: "sheets",
      location: "Warehouse A · Rack 01",
      cost: 65,
    },
    {
      id: "i5",
      name: "Heavy-duty work gloves",
      sku: "SF-003",
      category: "Safety",
      quantity: 3,
      minimum: 8,
      unit: "pairs",
      location: "Workshop · Cabinet 03",
      cost: 18,
    },
  ],
  employees: [
    {
      id: "e1",
      name: "Alex Morgan",
      position: "Project Manager",
      hired: "2022-03-14",
      contributions: 24,
      email: "alex@example.com",
    },
    {
      id: "e2",
      name: "Jamie Chen",
      position: "Production Lead",
      hired: "2021-06-01",
      contributions: 38,
      email: "jamie@example.com",
    },
    {
      id: "e3",
      name: "Taylor Brooks",
      position: "Inventory Specialist",
      hired: "2023-01-09",
      contributions: 17,
      email: "taylor@example.com",
    },
    {
      id: "e4",
      name: "Sam Rivera",
      position: "Workshop Technician",
      hired: "2023-08-21",
      contributions: 21,
      email: "sam@example.com",
    },
    {
      id: "e5",
      name: "Jordan Lee",
      position: "Designer",
      hired: "2024-02-12",
      contributions: 12,
      email: "jordan@example.com",
    },
  ],
  sessions: [],
  timer: null,
  activity: [
    {
      text: "Jamie updated Spring product collection",
      time: Date.now() - 3600000,
    },
    {
      text: "White oak boards restocked · +20 boards",
      time: Date.now() - 7200000,
    },
    {
      text: "Safety & equipment review completed",
      time: Date.now() - 86400000,
    },
  ],
});
const storage = window.workspace || {
  read: async () => JSON.parse(localStorage.getItem("workorder-v1") || "null"),
  save: async (data) =>
    localStorage.setItem("workorder-v1", JSON.stringify(data)),
};
let state,
  page = "Overview",
  query = "",
  filter = "All projects",
  employeeSort = "name",
  selectedProject = null;
let saving = Promise.resolve();
function notify(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  setTimeout(() => $("#toast").classList.remove("visible"), 3500);
}
async function save(message) {
  const snapshot = JSON.parse(JSON.stringify(state));
  saving = saving.catch(() => {}).then(() => storage.save(snapshot));
  try {
    await saving;
    if (message) notify(message);
  } catch {
    notify("Could not save your changes. Check available disk space.");
  }
}
function log(text) {
  state.activity.unshift({ text, time: Date.now() });
  state.activity = state.activity.slice(0, 60);
}
const initials = (name) =>
  name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("");
const progress = (p) =>
  p.tasks.length
    ? Math.round((p.tasks.filter((t) => t.done).length / p.tasks.length) * 100)
    : 0;
const badge = (s) =>
  `<span class="badge ${s === "Completed" ? "green" : s === "In progress" ? "blue" : s === "Low stock" ? "amber" : "neutral"}">${esc(s)}</span>`;
const money = (n) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
const niceDate = (d) =>
  new Date(d + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
const duration = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
};
function render() {
  const low = state.inventory.filter((i) => i.quantity < i.minimum);
  $("#app").innerHTML =
    `<aside><a class="brand" href="#"><span class="brand-icon">w<span>•</span></span>WorkOrder<span class="brand-dot">.</span></a><button class="workspace-switch" data-action="workspace"><span class="workspace-avatar">S</span><span>Studio workspace<small>Local workspace</small></span><span class="chevron">⌄</span></button><div class="nav-label">WORKSPACE</div><nav>${[
      ["Overview", "grid"],
      ["Projects", "projects"],
      ["Inventory", "inventory"],
      ["Time tracking", "time"],
      ["Employees", "employees"],
    ]
      .map(
        ([name, icon]) =>
          `<button data-page="${name}" class="nav-item ${page === name ? "active" : ""}"><span>${icons[icon]}</span>${name}${name === "Inventory" && low.length ? `<b>${low.length}</b>` : ""}</button>`,
      )
      .join(
        "",
      )}</nav><div class="sidebar-bottom"><div class="local-note"><span class="status-dot"></span> Your work stays here<small>Saved locally on this device</small></div><button class="profile" data-action="workspace"><span class="avatar">SW</span><span>Studio workspace<small>Workspace settings</small></span><span>⚙</span></button></div></aside><div class="main-shell"><header><div class="breadcrumb">Workspace <span>/</span> <strong>${page}</strong></div><div class="header-right"><span class="local-pill"><i></i> Local workspace</span><button class="icon-button" data-action="activity" aria-label="Recent activity">♧</button><span class="avatar small">SW</span></div></header><main><div class="page-heading"><div><div class="eyebrow">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div><h1>${page === "Overview" ? "Your work, in order." : page}</h1><p>${{ Overview: "A little clarity for everything you’re working on.", Projects: "From the first idea to the final detail.", Inventory: "The right materials. In the right place.", "Time tracking": "Make space for focused, meaningful work.", Employees: "Good work starts with great people." }[page]}</p></div><button class="primary" data-action="${page === "Inventory" ? "add-item" : page === "Employees" ? "add-employee" : page === "Time tracking" ? "manual-time" : "add-project"}">＋ ${page === "Inventory" ? "Add material" : page === "Employees" ? "Add employee" : page === "Time tracking" ? "Log time" : "New project"}</button></div>${page === "Overview" ? overview(low) : page === "Projects" ? projects() : page === "Inventory" ? inventory() : page === "Employees" ? employees() : timeView()}</main><footer><span><span class="status-dot"></span> All systems ready</span><span>Made for the way you work. <b>WorkOrder v0.1</b></span></footer></div>`;
}
function stats() {
  const active = state.projects.filter((p) => p.status !== "Completed").length;
  const hours = state.sessions.reduce((n, s) => n + s.duration, 0) / 3600000;
  return `<div class="stats">${[
    [
      icons.projects,
      "Active projects",
      active,
      "Let’s keep things moving",
      "violet",
    ],
    [
      icons.inventory,
      "Materials in stock",
      state.inventory.length,
      `${state.inventory.filter((i) => i.quantity < i.minimum).length} materials running low`,
      "orange",
    ],
    [
      icons.time,
      "Hours tracked",
      hours.toFixed(1),
      "Your logged focus time",
      "blue",
    ],
    [
      icons.employees,
      "Team members",
      state.employees.length,
      "Great people, good work",
      "green",
    ],
  ]
    .map(
      ([icon, label, value, sub, color]) =>
        `<div class="stat"><div class="stat-top">${label}<span class="stat-icon ${color}">${icon}</span></div><div class="stat-value">${value}<span>${label === "Hours tracked" ? "hrs" : ""}</span></div><small>${sub}</small></div>`,
    )
    .join("")}</div>`;
}
function projectCard(p) {
  return `<button class="project-card" data-project="${p.id}"><div class="card-top"><span class="project-symbol ${p.category === "Production" ? "orange" : p.category === "Maintenance" ? "green" : "violet"}">${p.category === "Production" ? "◈" : p.category === "Maintenance" ? "✧" : "▤"}</span>${badge(p.status)}<span class="dots">↗</span></div><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><div class="progress-label"><span>Progress</span><strong>${progress(p)}%</strong></div><progress max="100" value="${progress(p)}"></progress><div class="card-bottom"><span><span class="avatar tiny">${initials(p.owner)}</span>${esc(p.owner.split(" ")[0])}</span><span>◷ ${niceDate(p.due)}</span></div></button>`;
}
function overview(low) {
  return `${stats()}<div class="dashboard-columns"><section><div class="section-heading"><h2>Projects in motion <span>${state.projects.filter((p) => p.status !== "Completed").length}</span></h2><button class="text-button" data-page="Projects">All projects ↗</button></div><div class="project-grid overview-projects">${
    state.projects
      .filter((p) => p.status !== "Completed")
      .slice(0, 2)
      .map(projectCard)
      .join("") || '<div class="empty">Your next project starts here.</div>'
  }</div><section class="panel stock-panel"><div class="section-heading"><h2><span class="warning-icon">!</span> Needs a restock <span>${low.length}</span></h2><button class="text-button" data-page="Inventory">View inventory ↗</button></div><p class="section-sub">A quick look at materials below their minimum stock.</p><table><thead><tr><th>Material</th><th>Available</th><th>Status</th><th></th></tr></thead><tbody>${
    low
      .slice(0, 4)
      .map(
        (i) =>
          `<tr><td><strong>${esc(i.name)}</strong><small>${esc(i.sku)} · ${esc(i.category)}</small></td><td><strong>${i.quantity} <span class="muted">${esc(i.unit)}</span></strong><small>Min. ${i.minimum}</small></td><td>${badge("Low stock")}</td><td><button class="text-button" data-stock="${i.id}">Restock ＋</button></td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="4">All materials are well stocked.</td></tr>'
  }</tbody></table></section></section><section class="right-column">${timerPanel()}<div class="panel activity-panel"><div class="section-heading"><h2>Recent activity</h2><span class="muted">↗</span></div>${activityList(4)}<div class="activity-foot">A little progress, every day.</div></div></section></div><div class="bottom-banner"><span class="banner-symbol">✳</span><div><strong>A place for every moving part.</strong><p>Less switching between tools. More getting things done.</p></div><button class="text-button" data-page="Employees">Meet your team →</button></div>`;
}
function activityList(limit = 20) {
  return `<div class="activity-list">${
    state.activity
      .slice(0, limit)
      .map(
        (a, i) =>
          `<div class="activity"><span class="activity-dot ${i % 2 ? "green" : "violet"}">${i % 2 ? "↗" : "✓"}</span><div><p>${esc(a.text)}</p><small>${new Date(a.time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></div></div>`,
      )
      .join("") ||
    '<p class="muted">Your workspace activity will appear here.</p>'
  }</div>`;
}
function timerPanel() {
  return `<div class="timer-panel"><div class="section-heading"><h2>Time to focus</h2><span>◷</span></div><p>One thing at a time. You’ve got this.</p><div class="timer" id="timer">${duration(state.timer ? Date.now() - state.timer.started : 0)}</div><div class="timer-caption">${state.timer ? "FOCUS SESSION IN PROGRESS" : "READY WHEN YOU ARE"}</div><select aria-label="Timer project" id="timer-project" ${state.timer ? "disabled" : ""}>${state.projects
    .filter((p) => p.status !== "Completed" || p.id === state.timer?.projectId)
    .map(
      (p) =>
        `<option value="${p.id}" ${state.timer?.projectId === p.id ? "selected" : ""}>${esc(p.name)}</option>`,
    )
    .join(
      "",
    )}<option value="general" ${state.timer?.projectId === "general" ? "selected" : ""}>General work</option></select><button class="primary timer-button" data-action="timer">${state.timer ? "■ Stop & save session" : "▷ Start timer"}</button><small class="timer-note">${state.timer ? "Your session continues if you close the app." : "Find your flow. We’ll watch the clock."}</small></div>`;
}
function toolbar(placeholder, extra = "") {
  return `<div class="toolbar"><label class="search"><span>⌕</span><input id="search" placeholder="${placeholder}" value="${esc(query)}" aria-label="${placeholder}"></label>${extra}</div>`;
}
function projects() {
  return `${toolbar("Search projects…", `<div class="tabs">${["All projects", "In progress", "Planning", "Completed"].map((s) => `<button data-filter="${s}" class="${filter === s ? "selected" : ""}">${s}</button>`).join("")}</div>`)}<div class="project-grid">${
    state.projects
      .filter(
        (p) =>
          (filter === "All projects" || p.status === filter) &&
          `${p.name} ${p.owner}`.toLowerCase().includes(query.toLowerCase()),
      )
      .map(projectCard)
      .join("") ||
    '<div class="empty">No projects found. Start a new project or try another search.</div>'
  }</div>`;
}
function inventory() {
  const items = state.inventory.filter((i) =>
    `${i.name} ${i.sku} ${i.category} ${i.location}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return `<div class="summary-strip"><span><strong>${state.inventory.length}</strong> materials</span><span><strong>${money(state.inventory.reduce((n, i) => n + i.cost * i.quantity, 0))}</strong> inventory value</span><span><strong>${state.inventory.filter((i) => i.quantity < i.minimum).length}</strong> below minimum</span></div>${toolbar("Search name, SKU, category or location…")}<div class="panel table-wrap"><table><thead><tr><th>Material / SKU</th><th>Category</th><th>Location</th><th>Stock / minimum</th><th>Unit cost</th><th>Status</th><th></th></tr></thead><tbody>${items.map((i) => `<tr><td><strong>${esc(i.name)}</strong><small>${esc(i.sku)}</small></td><td>${esc(i.category)}</td><td>${esc(i.location)}</td><td><strong>${i.quantity} ${esc(i.unit)}</strong><small>Minimum ${i.minimum}</small></td><td>${money(i.cost)}</td><td>${badge(i.quantity < i.minimum ? "Low stock" : "In stock")}</td><td><button class="text-button" data-stock="${i.id}">Adjust</button><button class="icon-button" data-edit-item="${i.id}" aria-label="Edit ${esc(i.name)}">✎</button></td></tr>`).join("") || '<tr><td colspan="7" class="empty">No materials found.</td></tr>'}</tbody></table></div>`;
}
function employees() {
  const rows = state.employees
    .filter((e) =>
      `${e.name} ${e.position}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      employeeSort === "contributions"
        ? b.contributions - a.contributions
        : String(a[employeeSort]).localeCompare(String(b[employeeSort])),
    );
  return `${toolbar(
    "Search people or positions…",
    `<label class="sort-label">Sort by <select id="employee-sort">${[
      ["name", "Name"],
      ["position", "Position"],
      ["hired", "Date hired"],
      ["contributions", "Contributions"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${v === employeeSort ? "selected" : ""}>${l}</option>`,
      )
      .join("")}</select></label>`,
  )}<div class="panel table-wrap"><table><thead><tr><th>Team member</th><th>Position</th><th>Date hired</th><th>Contributions</th><th></th></tr></thead><tbody>${rows.map((e) => `<tr><td><div class="person"><span class="avatar">${esc(initials(e.name))}</span><span><strong>${esc(e.name)}</strong><small>${esc(e.email)}</small></span></div></td><td>${esc(e.position)}</td><td>${esc(e.hired)}</td><td><strong>${e.contributions}</strong> completed contributions</td><td><button class="text-button" data-employee="${e.id}">Edit profile ↗</button></td></tr>`).join("") || '<tr><td colspan="5" class="empty">No team members found.</td></tr>'}</tbody></table></div><p class="helper">Contributions are manually maintained in each employee’s profile.</p>`;
}
function timeView() {
  return `<div class="time-layout">${timerPanel()}<div class="panel"><div class="section-heading"><h2>Session history</h2><span class="muted">${state.sessions.length} sessions</span></div><table><thead><tr><th>Project</th><th>Date</th><th>Duration</th></tr></thead><tbody>${
    state.sessions
      .slice()
      .reverse()
      .map(
        (s) =>
          `<tr><td><strong>${esc(state.projects.find((p) => p.id === s.projectId)?.name || "General work")}</strong></td><td>${new Date(s.started).toLocaleDateString()}</td><td>${duration(s.duration)}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="3" class="empty">Start your first session. Every bit of focus counts.</td></tr>'
  }</tbody></table></div></div>`;
}
function modal(title, body, onSubmit) {
  const d = $("#modal");
  d.innerHTML = `<form><div class="modal-heading"><h2>${esc(title)}</h2><button type="button" class="icon-button" data-close aria-label="Close dialog">×</button></div>${body}</form>`;
  d.querySelector("[data-close]").onclick = () => d.close();
  d.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    await onSubmit?.(new FormData(e.target));
  };
  if (!d.open) d.showModal();
}
const field = (label, name, value = "", type = "text", extra = "") =>
  `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" required ${extra}></label>`;
const submit = (label) =>
  `<div class="modal-actions"><button class="primary" type="submit">${label}</button></div>`;
function projectForm() {
  modal(
    "Start something great",
    `${field("Project name", "name")}${field("Description", "description")}<div class="form-row">${field("Category", "category", "Operations")}${field("Due date", "due", date(7), "date")}</div><label class="field">Project owner<select name="owner">${state.employees.map((e) => `<option>${esc(e.name)}</option>`).join("")}<option>Unassigned</option></select></label>${submit("Create project")}`,
    async (f) => {
      const p = {
        ...Object.fromEntries(f),
        id: crypto.randomUUID(),
        status: "Planning",
        tasks: [],
      };
      state.projects.push(p);
      log(`Created ${p.name}`);
      await save("Project created");
      $("#modal").close();
      render();
    },
  );
}
function projectDetail(id) {
  selectedProject = id;
  const p = state.projects.find((p) => p.id === id);
  modal(
    p.name,
    `<p class="modal-description">${esc(p.description)}</p><div class="detail-meta"><span>${esc(p.owner)} · Due ${niceDate(p.due)}</span>${badge(p.status)}</div><label class="field">Project status<select id="project-status">${["Planning", "In progress", "Completed"].map((s) => `<option ${p.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label><h3>Project checklist</h3><div class="checklist">${p.tasks.map((t, i) => `<label><input type="checkbox" data-task="${i}" ${t.done ? "checked" : ""}><span class="${t.done ? "done" : ""}">${esc(t.name)}</span></label>`).join("") || '<p class="muted">Add a first task to turn your plan into progress.</p>'}</div><div class="add-task"><input name="task" placeholder="Add a task…" required maxlength="180"><button class="primary">＋ Add</button></div>`,
    async (f) => {
      p.tasks.push({ name: String(f.get("task")).trim(), done: false });
      if (p.status === "Completed") p.status = "In progress";
      await save();
      render();
      projectDetail(id);
    },
  );
  $("#project-status").onchange = async (e) => {
    p.status = e.target.value;
    if (p.status === "Completed") p.tasks.forEach((t) => (t.done = true));
    log(`${p.name} marked ${p.status.toLowerCase()}`);
    await save("Project updated");
    render();
    projectDetail(id);
  };
  $("#modal")
    .querySelectorAll("[data-task]")
    .forEach(
      (el) =>
        (el.onchange = async () => {
          p.tasks[Number(el.dataset.task)].done = el.checked;
          if (!el.checked && p.status === "Completed") p.status = "In progress";
          await save();
          render();
          projectDetail(id);
        }),
    );
}
function itemForm(id) {
  const item = state.inventory.find((i) => i.id === id);
  const i = item || {
    name: "",
    sku: "",
    category: "",
    quantity: 0,
    minimum: 0,
    unit: "pcs",
    location: "",
    cost: 0,
  };
  modal(
    item ? "Edit material" : "Add a material",
    `${field("Material name", "name", i.name)}<div class="form-row">${field("SKU", "sku", i.sku)}${field("Category", "category", i.category)}</div>${field("Storage location", "location", i.location)}<div class="form-row">${field("Quantity", "quantity", i.quantity, "number", 'min="0" step="any"')}${field("Minimum stock", "minimum", i.minimum, "number", 'min="0" step="any"')}</div><div class="form-row">${field("Unit", "unit", i.unit)}${field("Unit cost ($)", "cost", i.cost, "number", 'min="0" step="0.01"')}</div>${submit("Save material")}`,
    async (f) => {
      const next = {
        ...Object.fromEntries(f),
        id: item?.id || crypto.randomUUID(),
      };
      for (const k of ["quantity", "minimum", "cost"])
        next[k] = Number(next[k]);
      if (
        state.inventory.some(
          (x) =>
            x.id !== next.id && x.sku.toLowerCase() === next.sku.toLowerCase(),
        )
      )
        return notify("That SKU already exists. Use a unique SKU.");
      if (item) Object.assign(item, next);
      else state.inventory.push(next);
      log(`${item ? "Updated" : "Added"} ${next.name}`);
      await save("Material saved");
      $("#modal").close();
      render();
    },
  );
}
function stockForm(id) {
  const i = state.inventory.find((x) => x.id === id);
  modal(
    "Adjust stock",
    `<p class="modal-description">${esc(i.name)} · Currently ${i.quantity} ${esc(i.unit)}</p><label class="field">Movement<select name="direction"><option value="1">Receive stock (+)</option><option value="-1">Use stock (−)</option></select></label>${field("Quantity", "amount", 1, "number", 'min="0.01" step="any"')}${field("Reason / reference", "reason", "Material delivery")}${submit("Save movement")}`,
    async (f) => {
      const delta = Number(f.get("direction")) * Number(f.get("amount"));
      if (i.quantity + delta < 0)
        return notify("There is not enough stock for this movement.");
      i.quantity = Math.round((i.quantity + delta) * 10000) / 10000;
      log(
        `${i.name} · ${delta > 0 ? "+" : ""}${delta} ${i.unit} · ${f.get("reason")}`,
      );
      await save("Stock updated");
      $("#modal").close();
      render();
    },
  );
}
function employeeForm(id) {
  const e = state.employees.find((e) => e.id === id);
  modal(
    e ? "Edit employee" : "Welcome someone new",
    `${field("Full name", "name", e?.name)}${field("Position", "position", e?.position)}${field("Email", "email", e?.email, "email")}<div class="form-row">${field("Date hired", "hired", e?.hired || date(), "date")}${field("Contributions", "contributions", e?.contributions || 0, "number", 'min="0" step="1"')}</div>${submit("Save employee")}`,
    async (f) => {
      const data = {
        ...Object.fromEntries(f),
        contributions: Number(f.get("contributions")),
        id: e?.id || crypto.randomUUID(),
      };
      if (e) Object.assign(e, data);
      else state.employees.push(data);
      log(`${e ? "Updated" : "Added"} employee ${data.name}`);
      await save("Employee saved");
      $("#modal").close();
      render();
    },
  );
}
async function timerAction() {
  if (state.timer) {
    const s = {
      ...state.timer,
      duration: Date.now() - state.timer.started,
      id: crypto.randomUUID(),
    };
    state.sessions.push(s);
    state.timer = null;
    log(`Focus session saved · ${duration(s.duration)}`);
  } else
    state.timer = { started: Date.now(), projectId: $("#timer-project").value };
  await save(state.timer ? "Focus timer started" : "Session saved");
  render();
}
function manualTime() {
  modal(
    "Log a work session",
    `<label class="field">Project<select name="projectId">${state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}<option value="general">General work</option></select></label>${field("Date", "date", date(), "date", `max="${date()}"`)}${field("Minutes worked", "minutes", 30, "number", 'min="1" max="1440"')}${submit("Log session")}`,
    async (f) => {
      state.sessions.push({
        id: crypto.randomUUID(),
        projectId: f.get("projectId"),
        started: new Date(f.get("date") + "T12:00:00").getTime(),
        duration: Number(f.get("minutes")) * 60000,
      });
      log(`Logged ${f.get("minutes")} minutes of work`);
      await save("Session logged");
      $("#modal").close();
      render();
    },
  );
}
function workspaceSettings() {
  modal(
    "Your local workspace",
    `<p class="modal-description">WorkOrder saves your projects, materials, people, and time on this device. This workspace starts with editable sample data.</p><div class="settings-note">${window.workspace ? "Desktop mode · Data is stored in the application’s user data folder." : "Browser preview · Data is stored in this browser. Desktop data is separate."}</div><button type="button" class="secondary" id="export">↓ Export workspace backup</button><p class="helper">Exports your full workspace as JSON for safekeeping.</p>`,
  );
  $("#export").onclick = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `workorder-${date()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Workspace exported");
  };
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.page) {
    page = b.dataset.page;
    query = "";
    filter = "All projects";
    render();
    return;
  }
  if (b.dataset.project) return projectDetail(b.dataset.project);
  if (b.dataset.stock) return stockForm(b.dataset.stock);
  if (b.dataset.editItem) return itemForm(b.dataset.editItem);
  if (b.dataset.employee) return employeeForm(b.dataset.employee);
  if (b.dataset.filter) {
    filter = b.dataset.filter;
    render();
    return;
  }
  ({
    "add-project": projectForm,
    "add-item": () => itemForm(),
    "add-employee": () => employeeForm(),
    timer: timerAction,
    "manual-time": manualTime,
    workspace: workspaceSettings,
    activity: () => modal("Recent activity", activityList()),
  })[b.dataset.action]?.();
});
document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    const pos = e.target.selectionStart;
    query = e.target.value;
    render();
    $("#search").focus();
    $("#search").setSelectionRange(pos, pos);
  }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "employee-sort") {
    employeeSort = e.target.value;
    render();
  }
});
setInterval(() => {
  if (state?.timer && $("#timer"))
    $("#timer").textContent = duration(Date.now() - state.timer.started);
}, 1000);
try {
  state = await storage.read();
  if (!state) {
    state = seed();
    await storage.save(state);
  }
  if (
    state.version !== 1 ||
    !["projects", "inventory", "employees", "sessions", "activity"].every((k) =>
      Array.isArray(state[k]),
    )
  )
    throw new Error("Invalid workspace");
  render();
} catch (error) {
  $("#app").innerHTML =
    '<div class="load-error"><h1>Your workspace could not be loaded.</h1><p>Your saved data has not been overwritten. Check your storage permissions and restart WorkOrder.</p></div>';
  console.error(error);
}
