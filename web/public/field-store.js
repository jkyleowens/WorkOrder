// Each queue item has its own key so another tab cannot overwrite a whole queue.
const prefix = (user) => `workorder:field:${user}:`;
export function queue(user) {
  return Object.keys(localStorage)
    .filter((k) => k.startsWith(prefix(user) + "queue:"))
    .map((k) => JSON.parse(localStorage.getItem(k)))
    .sort((a, b) => a.created.localeCompare(b.created));
}
export function saveQueued(user, item) {
  localStorage.setItem(
    prefix(user) + "queue:" + item.payload.request_key,
    JSON.stringify(item),
  );
}
export function removeQueued(user, key) {
  localStorage.removeItem(prefix(user) + "queue:" + key);
}
export function enqueue(user, payload) {
  const item = {
    payload: { ...payload, request_key: crypto.randomUUID() },
    created: new Date().toISOString(),
    error: "",
  };
  saveQueued(user, item);
  return item;
}
export function activeClock(user, value) {
  const key = prefix(user) + "clock";
  if (value === null) localStorage.removeItem(key);
  else if (value !== undefined)
    localStorage.setItem(key, JSON.stringify(value));
  return JSON.parse(localStorage.getItem(key) || "null");
}
export function snapshot(user, value) {
  const key = prefix(user) + "snapshot";
  if (value) localStorage.setItem(key, JSON.stringify(value));
  return JSON.parse(localStorage.getItem(key) || "null");
}
export function day(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const clock = (d) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
export function clockEntries(start, end) {
  const from = new Date(start),
    to = new Date(end);
  from.setSeconds(0, 0);
  to.setSeconds(0, 0);
  if (to <= from)
    throw new Error("Record at least one minute before clocking out.");
  if (to - from > 31 * 86400000)
    throw new Error(
      "This clock spans more than 31 days. Correct it before saving.",
    );
  const entries = [];
  let cursor = from;
  while (cursor < to) {
    const midnight = new Date(cursor);
    midnight.setHours(24, 0, 0);
    const stop = midnight < to ? midnight : to;
    entries.push({
      date: day(cursor),
      start_time: clock(cursor),
      end_time: clock(stop),
      note: "Field clock",
    });
    cursor = stop;
  }
  return entries;
}
