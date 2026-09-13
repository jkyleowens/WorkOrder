export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const money = (value) =>
  Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const dateLabel = (value) =>
  new Date(
    value.length === 10 ? value + "T12:00:00" : value,
  ).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
export const status = (value) =>
  `<span class="status ${esc(value)}">${esc(value)}</span>`;
export const initials = (name) =>
  esc(
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase(),
  );
export const icon = (name) => {
  const paths = {
    billing: "M5 3h14v18l-3-2-4 2-4-2-3 2z M8 8h8 M8 12h8 M8 16h4",
    inbox: "M3 4h18v16H3z M3 13h5l2 3h4l2-3h5 M7 8h10",
    overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    projects: "M3 7h18v14H3z M8 7V3h8v4",
    jobs: "M4 4h16v17H4z M8 9h8 M8 13h8 M8 17h4",
    time: "M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    inventory: "m3 7 9-4 9 4v11l-9 4-9-4z M3 7l9 4 9-4 M12 11v11",
    people:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4",
    arrow: "M5 12h14 M13 6l6 6-6 6",
    plus: "M12 5v14 M5 12h14",
    logout: "M9 4H3v16h6 M9 12h12 M17 8l4 4-4 4",
    check: "m5 12 4 4 10-10",
    profile: "M20 21a8 8 0 0 0-16 0 M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${(
    paths[name] || paths.projects
  )
    .split(" M")
    .map((p, i) => `<path d="${i ? "M" : ""}${p}"/>`)
    .join("")}</svg>`;
};
export const button = (label, action, id = "", kind = "secondary") =>
  `<button type="button" class="btn ${kind}" data-action="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
export const link = (label, route, kind = "secondary") =>
  `<a class="btn ${kind}" href="#${esc(route)}">${esc(label)}</a>`;
export const field = (label, name, type = "text", value = "", attrs = "") =>
  `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
export const textarea = (label, name, value = "", attrs = "") =>
  `<label>${esc(label)}<textarea name="${name}" rows="4" ${attrs}>${esc(value)}</textarea></label>`;
export const select = (label, name, options, value = "") =>
  `<label>${esc(label)}<select aria-label="${esc(label)}" name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(value) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
export const empty = (title, description, cta = "") =>
  `<div class="empty"><span class="empty-icon">${icon("projects")}</span><h3>${esc(title)}</h3><p>${esc(description)}</p>${cta}</div>`;
export const heading = (eyebrow, title, description, action = "") =>
  `<header class="page-heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h1 tabindex="-1">${esc(title)}</h1><p class="subtitle">${esc(description)}</p></div>${action}</header>`;
export const panel = (title, body, extra = "") =>
  `<section class="panel"><div class="panel-heading"><h2>${esc(title)}</h2>${extra}</div>${body}</section>`;
export const table = (headers, rows) =>
  `<div class="table-scroll"><table><thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
export const row = (cells) =>
  `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
export function toast(message) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("visible"), 4500);
}
export function modal(title, body, onSubmit, submit = "Save changes") {
  const dialog = document.querySelector("#modal");
  const focus = document.activeElement;
  dialog.innerHTML = `<form><div class="dialog-heading"><div><p class="eyebrow">WorkOrder</p><h2 id="dialog-title">${esc(title)}</h2></div><button type="button" class="close" aria-label="Close dialog">×</button></div><div class="form-fields">${body}</div><p class="form-error" role="alert" hidden></p><div class="dialog-footer"><button type="button" class="btn secondary cancel">Cancel</button>${onSubmit ? `<button class="btn primary" type="submit">${esc(submit)}</button>` : ""}</div></form>`;
  let busy = false;
  const close = () => {
    if (!busy) dialog.close();
  };
  dialog.querySelector(".close").onclick = close;
  dialog.querySelector(".cancel").onclick = close;
  dialog.oncancel = (e) => {
    if (busy) e.preventDefault();
  };
  dialog.onclose = () => {
    if (focus?.isConnected) focus.focus();
    else document.querySelector("#main h1")?.focus({ preventScroll: true });
  };
  dialog.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    if (!onSubmit || busy) return;
    busy = true;
    const buttons = dialog.querySelectorAll("button");
    buttons.forEach((b) => (b.disabled = true));
    const error = dialog.querySelector(".form-error");
    error.hidden = true;
    try {
      const result = await onSubmit(
        Object.fromEntries(new FormData(event.target)),
      );
      if (result !== false) dialog.close();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      error.scrollIntoView({ block: "nearest" });
    } finally {
      busy = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  dialog.showModal();
}
export const confirm = (title, message, onSubmit, label = "Confirm") =>
  modal(title, `<p>${esc(message)}</p>`, onSubmit, label);

export const organizationTypes = [
  ["contractor", "Contractor"],
  ["supplier", "Supplier"],
  ["labor_union", "Labor union"],
  ["client", "Client / developer"],
  ["consultant", "Consultant"],
  ["other", "Other"],
];
export const typeBadges = (types = []) =>
  `<div class="tags organization-types">${types.map((type) => `<span>${esc(organizationTypes.find(([key]) => key === type)?.[1] || type)}</span>`).join("")}</div>`;
export const typeFields = (types = []) =>
  `<fieldset class="type-picker"><legend>Organization types</legend><p class="hint">Choose all that describe your organization. You can change these later.</p><div>${organizationTypes.map(([key, label]) => `<label><input type="checkbox" name="type_${key}" ${types.includes(key) ? "checked" : ""}>${esc(label)}</label>`).join("")}</div></fieldset>`;
export const typeValues = (values) => ({
  name: values.name,
  trade_focus: values.trade_focus,
  organization_types: organizationTypes
    .filter(([key]) => values[`type_${key}`])
    .map(([key]) => key),
});
