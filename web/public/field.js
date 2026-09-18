import { api, write, uploadFile } from "./api.js";
import { assetUrl, homeHref } from "./native.js";
import { photoField, mountPhotos } from "./native-camera.js";
import { esc, field, textarea, select, modal, dateLabel } from "./ui.js";
const brand = `<a class="brand" href="${homeHref("/console")}"><img src="${assetUrl("mark.svg")}" alt="" width="28" height="28">WorkOrder<span>®</span></a>`;
const topbar = `<header class="field-topbar">${brand}<a class="back-link" href="${homeHref("/console")}">← Office workspace</a></header>`;
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
const root = document.querySelector("#field-app");
const initialRoute = new URLSearchParams(location.hash.slice(1));
let user,
  data,
  selected = initialRoute.get("scope"),
  tab = ["clock", "reports", "documents", "schedule"].includes(
    initialRoute.get("tab"),
  )
    ? initialRoute.get("tab")
    : "clock",
  busy = false,
  notice = "";
const btn = (label, action, id = "") =>
  `<button class="btn secondary" type="button" data-field="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
const required = "required";
function scope() {
  return data.scopes.find((s) => s.id === Number(selected));
}
const offline = () => !navigator.onLine;
function crew() {
  const s = scope();
  return s?.can_manage_crew
    ? data.crew[s.awarded_org_id] || []
    : [{ id: user.id, full_name: user.full_name }];
}
function peopleFields() {
  return `<fieldset><legend>Crew to record</legend>${crew()
    .map(
      (p) =>
        `<label><input type="checkbox" name="worker" value="${p.id}" ${p.id === user.id ? "checked" : ""}>${esc(p.full_name)}</label>`,
    )
    .join("")}</fieldset>`;
}
async function refresh() {
  const me = await api("/me");
  if (user && me.user.id !== user.id)
    throw new Error(
      "The signed-in account changed. Reopen the field workspace before syncing.",
    );
  user = me.user;
  data = await api("/field");
  snapshot(user.id, data);
  localStorage.setItem(
    "workorder:field:identity",
    JSON.stringify({ id: user.id, full_name: user.full_name }),
  );
  if (!data.scopes.some((s) => s.id === Number(selected)))
    selected = data.scopes[0]?.id;
}
async function start() {
  try {
    await refresh();
  } catch (e) {
    if (e.status === 401) {
      localStorage.removeItem("workorder:field:identity");
      root.innerHTML = `${topbar}<div class="field-shell-inner"><h1>Field work</h1><p><a href="/login">Sign in</a> online before using the field workspace.</p></div>`;
      return;
    }
    user = JSON.parse(
      localStorage.getItem("workorder:field:identity") || "null",
    );
    data = user && snapshot(user.id);
    if (!data) {
      root.innerHTML = `${topbar}<div class="field-shell-inner"><h1>Field work</h1><p>${esc(e.message)}</p><p>Open this page online once to prepare offline time entry.</p></div>`;
      return;
    }
    if (!data.scopes.some((s) => s.id === Number(selected)))
      selected = data.scopes[0]?.id;
    notice =
      "Using saved assignments. Time stays on this device until sync succeeds.";
  }
  await render();
  if ("serviceWorker" in navigator)
    navigator.serviceWorker
      .register("/field-sw.js", { scope: "/field" })
      .catch((e) => {
        notice = `Offline shell could not be prepared: ${e.message}`;
        render();
      });
  if (navigator.onLine) await sync();
}
async function render() {
  const s = scope(),
    items = queue(user.id),
    clock = activeClock(user.id);
  root.innerHTML = `${topbar}<div class="field-shell-inner"><div class="page-heading"><div><p class="eyebrow">${esc(user.full_name)}</p><h1>Field work</h1></div></div><p class="field-status" role="status">${offline() ? "Offline · time is saved on this device" : "Online"} · ${items.length} queued ${notice ? ` · ${esc(notice)}` : ""}</p><div class="actions">${btn("Sync time", "sync")}${btn("Refresh assignments", "refresh")}</div>${select("Work scope", "scope", [["", "Choose a scope"], ...data.scopes.map((s) => [s.id, `${s.project_title} · ${s.scope}`])], selected || "")}<nav class="field-tabs" aria-label="Field tools">${[
    ["clock", "Time clock"],
    ["reports", "Daily reports"],
    ["documents", "Documents"],
    ["schedule", "Schedule"],
  ]
    .map(
      ([key, label]) =>
        `<button type="button" class="field-tab" data-field="tab" data-id="${key}" ${tab === key ? 'aria-current="page"' : ""}>${esc(label)}</button>`,
    )
    .join("")}</nav><section id="field-content"></section></div>`;
  root.querySelector("[name=scope]").onchange = async (e) => {
    selected = e.target.value;
    await render();
  };
  const content = root.querySelector("#field-content");
  if (tab === "clock") {
    content.innerHTML = `${clock ? `<section class="clock-active"><strong>Clock running since ${esc(new Date(clock.started).toLocaleString())}</strong><p>${esc(clock.scope_name)} · ${clock.user_ids.length} workers</p>${btn("Clock out", "stop")}${btn("Correct running clock", "correct-clock")}</section>` : ""}${s?.can_record ? `<section class="panel"><h2>Record crew time</h2><p>Times use this device’s local dates and clock. Rates are captured from the applicable saved pay rate when synced.</p><form id="clock-form">${peopleFields()}<div class="actions">${!clock ? btn("Clock in", "start") : ""}</div><h3>Add a completed interval</h3>${field("Work date", "date", "date", day(), required)}${field("Start time", "start_time", "time", "", required)}${field("End time", "end_time", "time", "", required)}${textarea("Time note", "note")}<button class="btn primary" type="submit">Save time on device</button></form></section>` : "<p>Choose an active assigned scope to record time.</p>"}<section class="panel"><h2>Time waiting to sync</h2><p>Rows remain here until the server confirms them. Conflicts require review; retries never duplicate a saved batch.</p>${items.map((i) => `<article class="queue-item"><strong>${esc(data.scopes.find((s) => s.id === i.payload.subdivision_id)?.scope || `Scope ${i.payload.subdivision_id}`)}</strong><p>${i.payload.user_ids.length} workers · ${i.payload.entries.map((e) => `${esc(e.date)} ${esc(e.start_time)}–${esc(e.end_time)}`).join(", ")}</p>${i.error ? `<p class="field-error" role="alert">${esc(i.error)}</p>` : ""}${btn("Review / correct", "edit-time", i.payload.request_key)}${btn("Remove queued time", "remove-time", i.payload.request_key)}</article>`).join("") || "<p>All recorded time is synced.</p>"}</section>`;
    const form = content.querySelector("#clock-form");
    if (form)
      form.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const v = Object.fromEntries(new FormData(form));
          const ids = [...form.querySelectorAll("[name=worker]:checked")].map(
            (i) => Number(i.value),
          );
          if (!ids.length) throw new Error("Choose at least one worker.");
          enqueue(user.id, {
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
          notice = "Time saved on this device.";
          await render();
          if (navigator.onLine) await sync();
        } catch (e) {
          showError(e);
        }
      };
    return;
  }
  if (!s) {
    content.innerHTML = "<p>Choose a work scope.</p>";
    return;
  }
  if (offline() && tab !== "schedule") {
    content.innerHTML =
      "<p>Connect to view and save reports or documents. Time entry and the saved schedule remain available offline.</p>";
    return;
  }
  try {
    if (tab === "schedule") {
      const rows = data.scopes.filter((x) => x.project_id === s.project_id);
      const starts = rows
          .map((r) => r.effective_start)
          .filter(Boolean)
          .sort(),
        ends = rows
          .map((r) => r.planned_end)
          .filter(Boolean)
          .sort();
      content.innerHTML = `<section class="panel"><h2>${esc(s.project_title)} schedule</h2><p>Visible project dates: ${starts[0] ? `${esc(starts[0])} → ${esc(ends.at(-1))}` : "Not scheduled"}</p><p>Calendar days. A successor starts after its predecessor ends. Delays move dependent work automatically.</p>${select(
        "Show",
        "schedule-filter",
        [
          ["all", "All visible scopes"],
          ["week", "My work this week"],
        ],
        "all",
      )}<div id="schedule-rows"></div></section>`;
      const draw = (filter) => {
        const end = new Date();
        end.setDate(end.getDate() + 6);
        const filtered = rows.filter(
          (x) =>
            filter !== "week" ||
            (x.can_record &&
              x.effective_start &&
              x.effective_start <= day(end) &&
              x.planned_end >= day()),
        );
        content.querySelector("#schedule-rows").innerHTML =
          filtered
            .map(
              (x) =>
                `<article class="schedule-row"><strong>${esc(x.scope)} · ${esc(x.status)}</strong><p>${x.effective_start ? `${esc(x.effective_start)} → ${esc(x.planned_end)} · ${x.duration_days} days` : "Not scheduled"}${x.predecessor_id ? ` · After ${esc(rows.find((r) => r.id === x.predecessor_id)?.scope || "predecessor")}` : ""}</p>${x.can_schedule ? btn("Edit schedule", "plan", x.id) : ""}</article>`,
            )
            .join("") || "<p>No scheduled work in this window.</p>";
      };
      draw("all");
      content.querySelector("[name=schedule-filter]").onchange = (e) =>
        draw(e.target.value);
    }
    if (tab === "reports") {
      const rows = await api(`/subdivisions/${s.id}/reports`);
      content.innerHTML = `<section class="panel"><h2>Photo daily reports</h2>${s.can_record ? btn("Add daily report", "report") : ""}${rows.map((r) => `<article><h3>${esc(r.report_date)} · ${esc(r.author_name)}</h3><p>${esc(r.progress)}</p><p>Headcount: ${r.headcount} · Weather: ${esc(r.weather || "Not recorded")}</p><p>Deliveries: ${esc(r.deliveries || "None recorded")}</p><p>Delays: ${esc(r.delays || "None recorded")}</p><div class="field-photos">${r.file_ids.map((id) => `<a href="/api/files/${id}"><img src="/api/files/${id}" alt="Report ${r.id} progress photo" loading="lazy"></a>`).join("")}</div><small>Report ${r.id} · recorded ${esc(dateLabel(r.created_at))}</small></article>`).join("") || "<p>No daily reports yet.</p>"}</section>`;
    }
    if (tab === "documents") {
      const [docs, projectDocs] = await Promise.all([
        api(`/subdivisions/${s.id}/documents`),
        api(`/projects/${s.project_id}/documents`),
      ]);
      const list = (rows) =>
        rows
          .map(
            (d) =>
              `<article class="schedule-row"><strong>${esc(d.title)} · v${d.version}${d.latest ? "" : " · superseded"}</strong><p>${esc(d.kind)} · ${esc(dateLabel(d.created_at))}</p>${btn("Read document", "document", d.id)}</article>`,
          )
          .join("") || "<p>No documents yet.</p>";
      content.innerHTML = `<section class="panel"><h2>Scope documents & signatures</h2>${s.can_document ? btn("Add scope document", "add-document", "scope") : ""}${list(docs)}</section><section class="panel"><h2>Project documents</h2>${s.can_project_document ? btn("Add project document", "add-document", "project") : ""}${list(projectDocs)}</section>`;
    }
  } catch (e) {
    content.innerHTML = `<p class="field-error" role="alert">${esc(e.message)}</p>`;
  }
}
function showError(e) {
  notice = e.message;
  const status = root.querySelector("[role=status]");
  if (status) status.textContent = notice;
}
async function sync() {
  if (busy || !user) return;
  busy = true;
  try {
    const me = await api("/me");
    if (me.user.id !== user.id)
      throw new Error(
        "Sign back into the account that recorded this time before syncing.",
      );
    const run = async () => {
      for (const item of queue(user.id)) {
        try {
          await write("/field/time", item.payload);
          removeQueued(user.id, item.payload.request_key);
        } catch (e) {
          item.error = e.message;
          saveQueued(user.id, item);
          if (!e.status || e.status === 401) break;
        }
      }
    };
    if (navigator.locks)
      await navigator.locks.request(`workorder-field-sync-${user.id}`, run);
    else await run();
    notice = queue(user.id).length
      ? "Some time needs review or a connection."
      : "Time sync complete.";
  } catch (e) {
    notice = e.message;
  } finally {
    busy = false;
    await render();
  }
}
async function upload(file) {
  if (!file?.size) return null;
  if (file.size > 4 * 1024 * 1024)
    throw new Error("Each attachment must be 4 MB or smaller.");
  return uploadFile(file);
}
async function documentView(id) {
  const d = await api(`/documents/${id}`);
  const content = root.querySelector("#field-content");
  content.innerHTML = `<section class="panel"><h2>${esc(d.title)} · version ${d.version}</h2><p>${d.superseded ? "Superseded version" : "Current version"} · ${esc(d.kind)}</p><pre>${esc(d.body)}</pre>${d.file_id ? `<p><a href="/api/files/${d.file_id}">Download attached document</a></p>` : ""}<p>Content fingerprint: ${esc(d.content_hash)}</p><div class="actions">${btn("Print / Save PDF", "print")}${!d.superseded && d.can_edit ? btn("Create new version", "version", d.id) : ""}</div>${
    d.can_sign.length
      ? `<form id="signature-form">${select(
          "Sign for",
          "party",
          d.can_sign.map((p) => [p, p]),
        )}${field("Full signer name", "signer_name", "text", user.full_name, 'required minlength="2" maxlength="120"')}<label><input type="checkbox" name="confirm" required> I have read this version and agree to sign for the selected party.</label><button class="btn primary" type="submit">Sign this version</button><p role="alert" class="field-error" id="sign-error"></p></form>`
      : ""
  }<h3>Views and signatures</h3>${d.events.map((e) => `<p>${esc(e.kind)} · ${esc(e.signer_name || e.full_name)}${e.party ? ` for ${esc(e.party)}` : ""} · ${esc(new Date(e.created_at).toLocaleString())}</p>`).join("")}</section>`;
  const form = content.querySelector("#signature-form");
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      const submit = form.querySelector("button");
      submit.disabled = true;
      try {
        const v = Object.fromEntries(new FormData(form));
        await write(`/documents/${id}/sign`, {
          party: v.party,
          signer_name: v.signer_name,
          confirm: true,
          content_hash: d.content_hash,
        });
        await documentView(id);
      } catch (e) {
        form.querySelector("#sign-error").textContent = e.message;
        submit.disabled = false;
      }
    };
}
async function documentForm(area, previous) {
  const s = scope();
  const old = previous ? await api(`/documents/${previous}`) : null;
  const project = old ? old.subdivision_id === null : area === "project";
  return modal(
    old ? "Create new document version" : "Add document",
    field(
      "Title",
      "title",
      "text",
      old?.title || "",
      'required maxlength="200"',
    ) +
      select(
        "Document kind",
        "kind",
        [
          ["scope", "Scope of work"],
          ["certificate", "Certificate"],
          ["waiver", "Waiver"],
          ["other", "Other"],
        ],
        old?.kind || "scope",
      ) +
      textarea("Document text", "body", old?.body || "", 'maxlength="10000"') +
      field(
        "Attachment (optional PDF or image)",
        "file",
        "file",
        "",
        'accept="application/pdf,image/*"',
      ),
    async (v) => {
      const file_id = await upload(v.file);
      await write(
        project
          ? `/projects/${s.project_id}/documents`
          : `/subdivisions/${s.id}/documents`,
        {
          title: v.title,
          body: v.body,
          kind: v.kind || "other",
          ...(file_id ? { file_id } : {}),
          ...(old ? { previous_id: old.id } : {}),
        },
      );
      await render();
    },
    "Save version",
  );
}
let actionBusy = false;
root.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-field]");
  if (!b || actionBusy) return;
  actionBusy = true;
  try {
    const name = b.dataset.field,
      id = b.dataset.id,
      s = scope();
    if (name === "tab") {
      tab = id;
      await render();
    }
    if (name === "sync") await sync();
    if (name === "refresh") {
      await refresh();
      notice = "Assignments refreshed.";
      await render();
    }
    if (name === "start") {
      const user_ids = [...root.querySelectorAll("[name=worker]:checked")].map(
        (x) => Number(x.value),
      );
      if (!user_ids.length) throw new Error("Choose at least one worker.");
      if (activeClock(user.id)) throw new Error("A clock is already running.");
      activeClock(user.id, {
        started: new Date().toISOString(),
        user_ids,
        subdivision_id: s.id,
        scope_name: s.scope,
      });
      await render();
    }
    if (name === "stop") {
      const c = activeClock(user.id);
      if (!c) throw new Error("No clock is running.");
      const entries = clockEntries(c.started, new Date().toISOString());
      enqueue(user.id, {
        subdivision_id: c.subdivision_id,
        user_ids: c.user_ids,
        entries,
      });
      activeClock(user.id, null);
      await render();
      if (navigator.onLine) await sync();
    }
    if (name === "correct-clock") {
      const c = activeClock(user.id);
      const local = new Date(
        new Date(c.started).getTime() -
          new Date(c.started).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16);
      modal(
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
          activeClock(user.id, { ...c, started: time.toISOString() });
          await render();
        },
      );
    }
    if (name === "remove-time")
      modal(
        "Remove queued time",
        "<p>This removes the unsynced time from this device. Saved server hours remain in Time & reports.</p>",
        async () => {
          removeQueued(user.id, id);
          await render();
        },
        "Remove queued time",
      );
    if (name === "edit-time") {
      const item = queue(user.id).find((x) => x.payload.request_key === id);
      modal(
        "Review queued time",
        `<p>${esc(item.error || "Correct dates and times before syncing.")} All rows in this batch use the selected crew.</p>` +
          item.payload.entries
            .map(
              (r, i) =>
                field(
                  `Date ${i + 1}`,
                  `date_${i}`,
                  "date",
                  r.date,
                  "required",
                ) +
                field(
                  `Start ${i + 1}`,
                  `start_${i}`,
                  "time",
                  r.start_time,
                  "required",
                ) +
                field(
                  `End ${i + 1}`,
                  `end_${i}`,
                  "time",
                  r.end_time,
                  "required",
                ),
            )
            .join(""),
        async (v) => {
          const entries = item.payload.entries.map((r, i) => ({
            ...r,
            date: v[`date_${i}`],
            start_time: v[`start_${i}`],
            end_time: v[`end_${i}`],
          }));
          enqueue(user.id, { ...item.payload, entries });
          removeQueued(user.id, id);
          await render();
        },
        "Save correction",
      );
    }
    if (name === "report") {
      let camera;
      modal(
        "Add daily report",
        field("Report date", "report_date", "date", day(), "required") +
          textarea("Progress", "progress", "", 'required maxlength="10000"') +
          field(
            "Headcount",
            "headcount",
            "number",
            "1",
            'required min="0" max="10000"',
          ) +
          field("Weather", "weather") +
          textarea("Deliveries", "deliveries") +
          textarea("Delays", "delays") +
          photoField({ name: "photos", legend: "Progress photos", max: 12 }),
        async (v) => {
          // Photos are downscaled on the device first: a current phone camera
          // writes 5-12 MB per shot and /api/files refuses anything over 4 MB,
          // so an unresized capture fails exactly when it matters — standing on
          // site with one bar of signal.
          const photos = await camera.files();
          if (photos.length > 12) throw new Error("Choose at most 12 photos.");
          const file_ids = [];
          for (const photo of photos) file_ids.push(await upload(photo));
          await write(`/subdivisions/${s.id}/reports`, {
            report_date: v.report_date,
            progress: v.progress,
            headcount: Number(v.headcount),
            weather: v.weather,
            deliveries: v.deliveries,
            delays: v.delays,
            file_ids,
          });
          await render();
        },
        "Save daily report",
      );
      // modal() renders synchronously, so the field exists to wire up now. On a
      // native build this reveals the camera buttons; on the web it leaves the
      // file input exactly as it was.
      camera = mountPhotos(document.querySelector("#modal"), {
        name: "photos",
        max: 12,
      });
    }
    if (name === "plan") {
      if (offline())
        throw new Error("Reconnect before editing the shared schedule.");
      const row = data.scopes.find((x) => x.id === Number(id));
      modal(
        "Edit schedule",
        field(
          "Earliest start",
          "planned_start",
          "date",
          row.planned_start || "",
        ) +
          field(
            "Duration (calendar days)",
            "duration_days",
            "number",
            row.duration_days,
            'required min="1" max="3650"',
          ) +
          select(
            "Predecessor",
            "predecessor_id",
            [
              ["", "None"],
              ...data.scopes
                .filter((x) => x.project_id === s.project_id && x.id !== row.id)
                .map((x) => [x.id, x.scope]),
            ],
            row.predecessor_id || "",
          ),
        async (v) => {
          await write(
            `/subdivisions/${id}/schedule`,
            {
              planned_start: v.planned_start || null,
              duration_days: Number(v.duration_days),
              predecessor_id: Number(v.predecessor_id) || null,
              expected_version: row.schedule_version,
            },
            "PUT",
          );
          await refresh();
          await render();
        },
        "Save schedule",
      );
    }
    if (name === "document") await documentView(id);
    if (name === "add-document") await documentForm(id);
    if (name === "version") await documentForm(null, id);
    if (name === "print") window.print();
  } catch (e) {
    showError(e);
  } finally {
    actionBusy = false;
  }
});
window.addEventListener("online", () => sync());
window.addEventListener("offline", () => render());
start();
