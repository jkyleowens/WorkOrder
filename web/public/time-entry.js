import { field, select, textarea, today, money, toast, empty } from "./ui.js";
import { write } from "./api.js";
const available = (c) =>
  c.data.assignments.filter(
    (s) =>
      ["awarded", "active"].includes(s.status) &&
      (!c.org || s.awarded_org_id === c.org.id),
  );
export function timeEntryForm(c) {
  const assignments = available(c);
  if (!assignments.length)
    return empty(
      "No active assignments",
      "Win a project bid, or join an organization with awarded work, to log time.",
    );
  return `<form id="time-entry-form">${select(
    "Project / assignment",
    "subdivision_id",
    assignments.map((s) => [
      s.id,
      `${s.project.title} · ${s.scope} (${s.awardedOrganization?.name || "independent"})`,
    ]),
    c.timeAssignment || assignments[0].id,
  )}<p class="hint">Enter up to 31 dated time ranges for one assignment. Midnight as an end time means the end of that date. Split overnight work across dates. All entries save together and flow into your time reports and project costs.</p><div id="time-entry-rows"></div><button type="button" class="btn secondary" data-add-time>Add another date</button><p class="pay-highlight" aria-live="polite" data-time-total></p><p class="form-error" role="alert" hidden></p><button type="submit" class="btn primary">Save time entries</button></form>`;
}
export function mountTimeEntry(root, c) {
  const form = root.querySelector("#time-entry-form");
  if (!form) return;
  const assignments = available(c),
    host = form.querySelector("#time-entry-rows"),
    add = form.querySelector("[data-add-time]");
  let serial = 0,
    busy = false;
  const preview = () => {
    const assignment = assignments.find(
      (s) => s.id === Number(form.elements.subdivision_id.value),
    );
    const member = c.memberships.find(
      (m) => m.org_id === assignment?.awarded_org_id,
    );
    const rate = Number(
      member?.hourly_rate ??
        member?.companyRole?.hourly_rate ??
        c.user.hourly_rate,
    );
    let hours = 0,
      cents = 0;
    for (const row of host.children) {
      const clockMode = row.querySelector("select").value === "clock";
      const clocks = [...row.querySelectorAll('[type="time"]')];
      clocks.forEach((el) => {
        el.required = clockMode;
        el.disabled = !clockMode;
        el.closest("label").hidden = !clockMode;
      });
      const hoursInput = row.querySelector('[type="number"]');
      hoursInput.required = !clockMode;
      hoursInput.readOnly = clockMode;
      if (clockMode) {
        const minutes = (value) => {
          const [h, m] = value.split(":").map(Number);
          return h * 60 + m;
        };
        const duration = clocks.every((el) => el.value)
          ? (clocks[1].value === "00:00" ? 1440 : minutes(clocks[1].value)) -
            minutes(clocks[0].value)
          : 0;
        clocks[1].setCustomValidity(
          duration < 0
            ? "End time must follow start time. Split overnight work across dates."
            : "",
        );
        hoursInput.value = duration > 0 ? (duration / 60).toFixed(2) : "";
      } else clocks[1].setCustomValidity("");
      const value = Number(hoursInput.value || 0);
      hours += value;
      cents += Math.round(value * rate * 100);
      row.querySelector("[data-remove-time]").disabled =
        host.children.length === 1;
    }
    add.disabled = host.children.length >= 31;
    form.querySelector("[data-time-total]").textContent =
      `${host.children.length} entries · ${hours.toFixed(2)} hours · ${money(cents / 100)} estimated labor at ${money(rate)}/hour`;
  };
  function addRow() {
    const i = serial++;
    const row = document.createElement("div");
    row.className = "time-entry-row";
    row.innerHTML = `${select(
      "Entry type",
      `type_${i}`,
      [
        ["clock", "Start and end times"],
        ["duration", "Hours only (times unknown)"],
      ],
      "clock",
    )}<div class="form-grid">${field("Start time", `start_${i}`, "time", "", "required")}${field("End time", `end_${i}`, "time", "", "required")}${field("Date worked", `date_${i}`, "date", today(), "required")}${field("Hours", `hours_${i}`, "number", "", 'required min="0.01" max="24" step="0.01"')}</div>${textarea("Note (optional)", `note_${i}`, "", 'maxlength="2000"')}<button type="button" class="btn secondary" data-remove-time>Remove date</button>`;
    row.dataset.index = i;
    row.querySelector("button").onclick = () => {
      row.remove();
      preview();
    };
    host.append(row);
    preview();
    return row;
  }
  add.onclick = () => {
    if (host.children.length < 31) addRow().querySelector("input").focus();
  };
  form.oninput = preview;
  form.onchange = preview;
  form.elements.subdivision_id.onchange = () => {
    c.timeAssignment = Number(form.elements.subdivision_id.value);
    preview();
  };
  addRow();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(form);
    const entries = [...host.children].map((row) => {
      const i = row.dataset.index;
      return {
        date: values.get(`date_${i}`),
        ...(values.get(`type_${i}`) === "clock"
          ? {
              start_time: values.get(`start_${i}`),
              end_time: values.get(`end_${i}`),
            }
          : { hours: Number(values.get(`hours_${i}`)) }),
        note: values.get(`note_${i}`),
      };
    });
    const error = form.querySelector("[role=alert]");
    error.hidden = true;
    busy = true;
    const controls = [
      ...form.querySelectorAll("input, select, textarea, button"),
    ];
    controls.forEach((el) => (el.disabled = true));
    try {
      await write("/time/bulk", {
        subdivision_id: Number(values.get("subdivision_id")),
        entries,
      });
      const dates = entries.map((e) => e.date).sort();
      c.range = {
        from: dates[0] < c.range.from ? dates[0] : c.range.from,
        to: dates.at(-1) > c.range.to ? dates.at(-1) : c.range.to,
      };
      if ((Date.parse(c.range.to) - Date.parse(c.range.from)) / 86400000 > 366)
        c.range = { from: dates[0], to: dates[0] };
      toast(`${entries.length} time entries saved`);
      await c.reload();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      busy = false;
      controls.forEach((el) => (el.disabled = false));
      preview();
    }
  };
}
