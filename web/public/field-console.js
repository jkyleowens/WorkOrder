// Field work, in the console: the same offline time queue as the standalone
// /field app (field-store.js), rendered as a normal console route so it never
// leaves the app shell. Daily reports, documents and the schedule stay on the
// full /field workspace for now; this covers the core ask — clocking in and
// out, and syncing hours — without a page navigation.
import { api, write } from "./api.js";
import { clockLocation } from "./native.js";
import {
  esc,
  field,
  textarea,
  heading,
  panel,
  button,
  select,
  modal,
  toast,
} from "./ui.js";
import {
  queue,
  saveQueued,
  removeQueued,
  enqueue,
  activeClock,
  snapshot,
  day,
  clockEntries,
} from "./field-store.js";
const offline = () => !navigator.onLine;
export async function syncField(userId) {
  const run = async () => {
    for (const item of queue(userId)) {
      try {
        await write("/field/time", item.payload);
        removeQueued(userId, item.payload.request_key);
      } catch (e) {
        item.error = e.message;
        saveQueued(userId, item);
        if (!e.status || e.status === 401) break;
      }
    }
  };
  if (navigator.locks)
    await navigator.locks.request(`workorder-field-sync-${userId}`, run);
  else await run();
}
function crewFields(data, s, user) {
  const crew = s?.can_manage_crew
    ? data.crew[s.awarded_org_id] || []
    : [{ id: user.id, full_name: user.full_name }];
  return `<fieldset><legend>Crew to record</legend>${crew
    .map(
      (p) =>
        `<label><input type="checkbox" name="worker" value="${p.id}" ${p.id === user.id ? "checked" : ""}>${esc(p.full_name)}</label>`,
    )
    .join("")}</fieldset>`;
}
export async function renderField(c) {
  let data,
    notice = "";
  try {
    data = await api("/field");
    snapshot(c.user.id, data);
  } catch (e) {
    data = snapshot(c.user.id);
    if (!data) throw e;
    notice =
      "Using saved assignments. Time stays on this device until sync succeeds.";
  }
  c.data.field = data;
  const selected =
    c.data.fieldScope && data.scopes.some((x) => x.id === c.data.fieldScope)
      ? c.data.fieldScope
      : data.scopes[0]?.id;
  c.data.fieldScope = selected;
  const s = data.scopes.find((x) => x.id === selected);
  const clock = activeClock(c.user.id);
  const items = queue(c.user.id);
  return (
    heading(
      "Field work",
      "Clock in from anywhere",
      "Time queues on this device and syncs the moment you’re back online.",
      '<a class="btn secondary" href="/field">Reports, documents &amp; schedule</a>',
    ) +
    `<p class="field-status" role="status">${offline() ? "Offline · time is saved on this device" : "Online"} · ${items.length} queued${notice ? ` · ${esc(notice)}` : ""}</p>` +
    `<div class="actions">${button("Sync time", "field-sync")}${button("Refresh assignments", "field-refresh")}</div>` +
    select(
      "Work scope",
      "field_scope",
      [
        ["", "Choose a scope"],
        ...data.scopes.map((x) => [x.id, `${x.project_title} · ${x.scope}`]),
      ],
      selected || "",
    ) +
    (clock
      ? panel(
          "Clock running",
          `<strong>Since ${esc(new Date(clock.started).toLocaleString())}</strong><p>${esc(clock.scope_name)} · ${clock.user_ids.length} worker${clock.user_ids.length === 1 ? "" : "s"}</p><div class="actions">${button("Clock out", "field-stop", "", "primary")}${button("Correct start time", "field-correct-clock")}</div>`,
        )
      : s?.can_record
        ? panel(
            "Record crew time",
            `<form id="field-clock-form">${crewFields(data, s, c.user)}<div class="actions">${button("Clock in", "field-start", "", "primary")}</div><h3>Add a completed interval</h3>${field("Work date", "date", "date", day(), "required")}${field("Start time", "start_time", "time", "", "required")}${field("End time", "end_time", "time", "", "required")}${textarea("Note", "note")}<button class="btn secondary" type="submit">Save time on device</button></form>`,
          )
        : `<p class="muted">Choose an active assigned scope to record time.</p>`) +
    panel(
      "Time waiting to sync",
      items.length
        ? items
            .map(
              (i) =>
                `<article class="queue-item"><strong>${esc(data.scopes.find((x) => x.id === i.payload.subdivision_id)?.scope || `Scope ${i.payload.subdivision_id}`)}</strong><p>${i.payload.user_ids.length} worker${i.payload.user_ids.length === 1 ? "" : "s"} · ${i.payload.entries.map((e) => `${esc(e.date)} ${esc(e.start_time)}–${esc(e.end_time)}`).join(", ")}</p>${i.error ? `<p class="field-error" role="alert">${esc(i.error)}</p>` : ""}${button("Remove queued time", "field-remove-time", i.payload.request_key, "danger")}</article>`,
            )
            .join("")
        : `<p class="muted">All recorded time is synced.</p>`,
    )
  );
}
export function mountField(root, c) {
  const scopeSelect = root.querySelector('[name="field_scope"]');
  if (scopeSelect)
    scopeSelect.onchange = (e) => {
      c.data.fieldScope = Number(e.target.value) || undefined;
      c.reload();
    };
  const form = root.querySelector("#field-clock-form");
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const v = Object.fromEntries(new FormData(form));
        const ids = [...form.querySelectorAll("[name=worker]:checked")].map(
          (i) => Number(i.value),
        );
        if (!ids.length) throw new Error("Choose at least one worker.");
        const s = c.data.field.scopes.find((x) => x.id === c.data.fieldScope);
        enqueue(c.user.id, {
          subdivision_id: s.id,
          user_ids: ids,
          entries: [
            {
              date: v.date,
              start_time: v.start_time,
              end_time: v.end_time,
              note: v.note,
            },
          ],
        });
        if (navigator.onLine) await syncField(c.user.id);
        await c.reload();
      } catch (err) {
        toast(err.message);
      }
    };
}
export async function fieldAction(c, name, id) {
  if (name === "field-sync") {
    await syncField(c.user.id);
    return c.reload();
  }
  if (name === "field-refresh") {
    c.data.fieldScope = undefined;
    return c.reload();
  }
  if (name === "field-start") {
    const ids = [
      ...document.querySelectorAll("#field-clock-form [name=worker]:checked"),
    ].map((i) => Number(i.value));
    if (!ids.length) throw new Error("Choose at least one worker.");
    if (activeClock(c.user.id)) throw new Error("A clock is already running.");
    const s = c.data.field.scopes.find((x) => x.id === c.data.fieldScope);
    // Taken now and carried on the running clock, because this is where the
    // shift actually started — by the time the queue syncs, which may be hours
    // later and miles away, the device's position means nothing. Returns null
    // if location is refused or slow; that is a valid entry, not a failure.
    const location = await clockLocation();
    activeClock(c.user.id, {
      started: new Date().toISOString(),
      user_ids: ids,
      subdivision_id: s.id,
      scope_name: s.scope,
      location,
    });
    return c.reload();
  }
  if (name === "field-stop") {
    const clock = activeClock(c.user.id);
    if (!clock) throw new Error("No clock is running.");
    const entries = clockEntries(clock.started, new Date().toISOString());
    enqueue(c.user.id, {
      subdivision_id: clock.subdivision_id,
      user_ids: clock.user_ids,
      // A shift that runs past midnight becomes several entries; they all
      // belong to the one place the clock was started.
      entries: clock.location
        ? entries.map((e) => ({ ...e, ...clock.location }))
        : entries,
    });
    activeClock(c.user.id, null);
    if (navigator.onLine) await syncField(c.user.id);
    return c.reload();
  }
  if (name === "field-correct-clock") {
    const clock = activeClock(c.user.id);
    const local = new Date(
      new Date(clock.started).getTime() -
        new Date(clock.started).getTimezoneOffset() * 60000,
    )
      .toISOString()
      .slice(0, 16);
    return modal(
      "Correct running clock",
      field(
        "Clock-in date and time",
        "started",
        "datetime-local",
        local,
        "required",
      ),
      async (v) => {
        const time = new Date(v.started);
        if (time > new Date()) throw new Error("Start must be in the past.");
        activeClock(c.user.id, { ...clock, started: time.toISOString() });
        await c.reload();
      },
    );
  }
  if (name === "field-remove-time") {
    removeQueued(c.user.id, id);
    return c.reload();
  }
}
