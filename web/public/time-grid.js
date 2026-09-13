import { esc, dateLabel, today } from "./ui.js";

const DAY = 86400;
const scales = [24, 60, 180, 720, 3600, 14400, 86400]; // pixels per hour
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const clock = (seconds) => {
  const s = Math.floor(seconds);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
};
export function timeGrid() {
  return `<div class="time-grid"><div class="timeline-toolbar"><div class="actions"><button type="button" class="btn secondary" data-zoom="out" aria-label="Zoom out">−</button><label>Scale <select aria-label="Timeline scale">${["Day overview", "Hours", "20 minutes", "5 minutes", "Minutes", "15 seconds", "Seconds"].map((label, i) => `<option value="${i}" ${i === 1 ? "selected" : ""}>${label}</option>`).join("")}</select></label><button type="button" class="btn secondary" data-zoom="in" aria-label="Zoom in">+</button><button type="button" class="btn secondary" data-reset>Reset view</button></div><label>Go to time <input type="time" step="1" value="00:00:00" aria-label="Go to time"></label></div><p class="muted timeline-help" id="timeline-help">Drag or scroll to pan · Ctrl/⌘ + scroll to zoom · Arrow keys to pan, +/− to zoom. Blocks show recorded start and end times. Entries without clock times are listed separately.</p><div class="timeline-viewport" tabindex="0" role="region" aria-label="Daily time grid" aria-describedby="timeline-help"><div class="timeline-canvas"></div></div><p class="timeline-status muted" aria-live="polite"></p><div class="timeline-detail" hidden></div></div>`;
}
export function mountTimeGrid(root, { entries, assignments }, range) {
  const host = root.querySelector(".time-grid");
  if (!host) return;
  const viewport = host.querySelector(".timeline-viewport");
  const canvas = host.querySelector(".timeline-canvas");
  const select = host.querySelector("select");
  const detail = host.querySelector(".timeline-detail");
  const dates = [];
  for (
    let dt = new Date(range.from + "T12:00:00");
    ;
    dt.setDate(dt.getDate() + 1)
  ) {
    const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    if (date > range.to || dates.length > 366) break;
    dates.push(date);
  }
  const titles = new Map(
    assignments.map((s) => [
      s.id,
      s.project ? `${s.project.title} · ${s.scope}` : s.scope,
    ]),
  );
  const seconds = (value) =>
    value
      .split(":")
      .reduce((total, part, i) => total + Number(part) * [3600, 60, 1][i], 0);
  const days = dates.map((date) => {
    const dayEntries = entries.filter((e) => e.date === date);
    const blocks = dayEntries
      .filter((e) => e.start_time && e.end_time)
      .map((entry) => ({
        entry,
        start: seconds(entry.start_time),
        end: seconds(entry.end_time),
      }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const lanes = [];
    blocks.forEach((block) => {
      let lane = lanes.findIndex((end) => end <= block.start);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = block.end;
      block.lane = lane;
    });
    return {
      date,
      blocks,
      lanes: lanes.length || 1,
      total: dayEntries.reduce((n, e) => n + Number(e.hours), 0),
    };
  });
  const unknown = entries.filter((e) => !e.start_time || !e.end_time);
  if (unknown.length) {
    const list = document.createElement("div");
    list.className = "timeline-unplaced";
    list.innerHTML = `<strong>Times not recorded</strong><p class="hint">These hours count toward your totals but have no position on the clock.</p>${unknown.map((e) => `<p>${esc(dateLabel(e.date))} · ${esc(titles.get(e.subdivision_id) || `Subdivision ${e.subdivision_id}`)} · ${esc(e.hours)} h</p>`).join("")}`;
    host.querySelector(".timeline-viewport").before(list);
  }
  const firstStart = Math.min(
    ...days.flatMap((day) => day.blocks.map((b) => b.start)),
  );
  const initialOffset = Number.isFinite(firstStart)
    ? Math.max(0, Math.floor(firstStart / 3600) * 3600 - 1800)
    : 0;
  let zoom = 1,
    offset = initialOffset,
    x = 0,
    drag = null,
    dragged = false;
  const gutter = 82,
    header = 65;
  let width, height, column;
  function draw() {
    width = viewport.clientWidth;
    height = viewport.clientHeight - header;
    column = Math.max(150, (width - gutter) / Math.min(7, days.length || 7));
    const scale = scales[zoom] / 3600;
    offset = clamp(offset, 0, Math.max(0, DAY - height / scale));
    x = clamp(x, 0, Math.max(0, days.length * column - width + gutter));
    const step = [3600, 3600, 1200, 300, 60, 15, 1][zoom];
    const first = Math.floor(offset / step) * step;
    let html = "";
    for (
      let t = first;
      t <= Math.min(DAY, offset + height / scale);
      t += step
    ) {
      const top = header + (t - offset) * scale;
      if (top < header) continue;
      html += `<div class="timeline-tick" style="top:${top}px"><span>${clock(t)}</span></div>`;
    }
    days.forEach((day, i) => {
      const left = gutter + i * column - x;
      if (left + column <= gutter || left >= width) return;
      html += `<div class="timeline-column" style="left:${left}px;width:${column}px"></div><div class="timeline-day ${day.date === today() ? "is-today" : ""}" style="left:${left}px;width:${column}px"><strong>${esc(new Date(day.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}</strong><span>${day.total.toFixed(2)} h worked</span></div>`;
      day.blocks.forEach(({ entry, start, end, lane }, index) => {
        const top = Math.max(0, (start - offset) * scale);
        const bottom = Math.min(height, (end - offset) * scale);
        if (bottom <= top) return;
        const title =
          titles.get(entry.subdivision_id) ||
          `Subdivision ${entry.subdivision_id}`;
        html += `<button type="button" class="timeline-block tone-${index % 3}" data-entry="${esc(entry.id)}" style="left:${left + (lane * column) / day.lanes + 5}px;top:${header + top}px;width:${column / day.lanes - 10}px;height:${bottom - top}px" aria-label="${esc(`${title}, ${entry.start_time.slice(0, 5)}–${entry.end_time.slice(0, 5)}, ${entry.hours} hours, ${dateLabel(day.date)}${entry.note ? `, ${entry.note}` : ""}`)}" title="${esc(`${title} · ${entry.hours} h`)}"><strong>${esc(title)}</strong><span>${esc(entry.start_time.slice(0, 5))}–${esc(entry.end_time.slice(0, 5))} · ${esc(entry.hours)} h</span>${entry.note ? `<small>${esc(entry.note)}</small>` : ""}</button>`;
      });
    });
    canvas.innerHTML = html + '<div class="timeline-corner">TIME</div>';
    select.value = String(zoom);
    host.querySelector('[data-zoom="out"]').disabled = zoom === 0;
    host.querySelector('[data-zoom="in"]').disabled =
      zoom === scales.length - 1;
    host.querySelector(".timeline-status").textContent =
      `${clock(offset)} – ${clock(Math.min(DAY, offset + height / scale))} · ${dates.length} days${entries.length ? "" : " · No time logged in this period"}`;
  }
  function setZoom(next, anchor = height / 2) {
    const time = offset + anchor / (scales[zoom] / 3600);
    zoom = clamp(next, 0, scales.length - 1);
    offset = time - anchor / (scales[zoom] / 3600);
    draw();
  }
  select.onchange = () => setZoom(Number(select.value));
  host
    .querySelectorAll("[data-zoom]")
    .forEach(
      (button) =>
        (button.onclick = () =>
          setZoom(zoom + (button.dataset.zoom === "in" ? 1 : -1))),
    );
  host.querySelector("[data-reset]").onclick = () => {
    zoom = 1;
    offset = initialOffset;
    x = 0;
    draw();
  };
  host.querySelector("input").onchange = (e) => {
    if (!e.target.value) return;
    const [h, m, s = 0] = e.target.value.split(":").map(Number);
    offset = h * 3600 + m * 60 + s;
    draw();
  };
  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1;
      if (e.ctrlKey || e.metaKey)
        setZoom(
          zoom + (e.deltaY < 0 ? 1 : -1),
          clamp(
            e.clientY - viewport.getBoundingClientRect().top - header,
            0,
            height,
          ),
        );
      else {
        x += (e.shiftKey ? e.deltaY : e.deltaX) * unit;
        if (!e.shiftKey) offset += (e.deltaY * unit) / (scales[zoom] / 3600);
        draw();
      }
    },
    { passive: false },
  );
  viewport.onpointerdown = (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, x, offset };
    dragged = false;
  };
  viewport.onpointermove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.startX,
      dy = e.clientY - drag.startY;
    if (Math.hypot(dx, dy) > 4) {
      dragged = true;
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add("is-panning");
      x = drag.x - dx;
      offset = drag.offset - dy / (scales[zoom] / 3600);
      draw();
    }
  };
  const stop = () => {
    drag = null;
    viewport.classList.remove("is-panning");
  };
  viewport.onpointerup = stop;
  viewport.onpointercancel = stop;
  viewport.onlostpointercapture = stop;
  viewport.onclick = (e) => {
    if (dragged && e.detail !== 0) return;
    const id = e.target.closest("[data-entry]")?.dataset.entry;
    const entry = entries.find((entry) => String(entry.id) === id);
    if (!entry) return;
    detail.hidden = false;
    detail.innerHTML = `<strong>${esc(titles.get(entry.subdivision_id) || `Subdivision ${entry.subdivision_id}`)}</strong><p>${esc(dateLabel(entry.date))} · ${esc(entry.start_time.slice(0, 5))}–${esc(entry.end_time.slice(0, 5))} · ${esc(entry.hours)} hours worked</p><p>${esc(entry.note || "No note for this entry.")}</p>`;
  };
  viewport.onkeydown = (e) => {
    if (
      ![
        "ArrowDown",
        "ArrowUp",
        "ArrowLeft",
        "ArrowRight",
        "+",
        "=",
        "-",
        "Home",
        "End",
      ].includes(e.key)
    )
      return;
    e.preventDefault();
    if (["+", "=", "-"].includes(e.key))
      return setZoom(zoom + (e.key === "-" ? -1 : 1));
    if (e.key === "Home") offset = 0;
    if (e.key === "End") offset = DAY;
    if (e.key === "ArrowDown") offset += 80 / (scales[zoom] / 3600);
    if (e.key === "ArrowUp") offset -= 80 / (scales[zoom] / 3600);
    if (e.key === "ArrowRight") x += column;
    if (e.key === "ArrowLeft") x -= column;
    draw();
  };
  draw();
  const observer = new ResizeObserver(draw);
  observer.observe(viewport);
  return () => observer.disconnect();
}
