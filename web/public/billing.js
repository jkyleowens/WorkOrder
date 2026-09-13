import { api, all, write } from "./api.js";
import {
  esc,
  money,
  dateLabel,
  today,
  heading,
  panel,
  table,
  row,
  status,
  link,
  button,
  empty,
  field,
  textarea,
  modal,
  toast,
} from "./ui.js";
const usd = (value) => `USD ${money(value)}`;
const metrics = (items) =>
  `<div class="stats billing-stats">${items.map(([label, value, source]) => `<div class="stat"><span>${esc(label)}</span><strong>${usd(value)}</strong><small>${esc(source)}</small></div>`).join("")}</div>`;
const number = (id) => String(id).padStart(4, "0");
const nextDay = (date) =>
  new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
const paidFor = (b, id) =>
  b.payments
    .filter((p) => p.application_id === id)
    .reduce(
      (n, p) => n + (p.reverses_payment_id ? -1 : 1) * Number(p.amount),
      0,
    );
const person = (b, id) =>
  b.people.find((p) => p.id === id)?.full_name || `User ${id}`;
export const applicationNumbers = (s) =>
  `<dl class="billing-calculation">${[
    ["Amended contract price", s.contract_value],
    ["Labor to period end · saved timesheet rates", s.labor_cost],
    ["Consumed materials to period end · saved unit costs", s.material_cost],
    ["Stored materials · contractor declaration", s.stored_materials],
    ["Gross earned to date", s.gross],
    [`Retainage held · ${s.retainage_percent}% cumulative`, s.retainage],
    ["Previously certified · approved applications", s.previous_certified],
    ["New amount requested", s.amount_due],
  ]
    .map(
      ([label, value]) =>
        `<div><dt>${esc(label)}</dt><dd>${usd(value)}</dd></div>`,
    )
    .join(
      "",
    )}</dl><p class="hint">Previous payments recorded at preparation: ${usd(s.previous_payments)}. Prior approved amounts are deducted even when unpaid, so they are never billed twice. Stored materials must exclude anything already consumed.</p>`;
export async function renderBilling(c, part, page) {
  if (!part) {
    const rows = await api(`/billing?limit=20&offset=${page * 20}`);
    c.data.billingRows = rows;
    return (
      heading(
        "Commercial workspace · USD",
        "Keep the work and the money connected",
        "Review scope changes, certify progress and track payments in one place.",
        link("Your projects", "projects/mine"),
      ) +
      `<div class="billing-notice"><span class="square-icon">↗</span><div><strong>From agreed scope to a clear payment record</strong><p>Applications use recorded labor and materials. Payments here record transactions made outside WorkOrder; no funds are held or transferred.</p></div></div>` +
      (rows.length
        ? panel(
            "Awarded work",
            table(
              [
                "Project / work package",
                "Amended price · USD",
                "Unpaid certified · USD",
                "To review",
                "",
              ],
              rows.map((r) =>
                row([
                  `<strong>${esc(r.project_title)}</strong><small>${esc(r.scope)}</small><small>${esc(r.contractor_name)}${r.parent_subdivision_id ? " · Subcontract" : " · Direct contract"}</small>`,
                  money(Number(r.awarded) + Number(r.accepted_changes)),
                  money(Number(r.certified) - Number(r.paid)),
                  `<span>${r.pending_applications} applications</span><small>${r.pending_changes} changes</small>`,
                  link("Open billing", `billing/${r.id}`),
                ]),
              ),
            ),
          )
        : empty(
            "Your next award starts here",
            "Award a project scope or win a bid to open its billing workspace.",
            link("Explore projects", "projects"),
          )) +
      `<div class="pager">${page ? link("Previous", `billing?page=${page - 1}`) : ""}<span>Page ${page + 1}</span>${rows.length === 20 ? link("Next", `billing?page=${page + 1}`) : ""}</div>`
    );
  }
  const b = (c.data.billing = await api(`/subdivisions/${part}/billing`));
  const t = b.totals,
    can = b.permissions;
  const latest = b.applications.filter((a) => a.status === "approved").at(-1);
  return (
    `<a class="back" href="#billing">← Billing</a>` +
    heading(
      `${b.project.title} · ${b.subdivision.parent_subdivision_id ? "Subcontract" : "Direct contract"}`,
      b.subdivision.scope,
      `${b.payer_name} → ${b.contractor_name}`,
      link("View project", `project/${b.project.id}`),
    ) +
    metrics([
      [
        "Amended contract",
        t.contract_value,
        `Award ${usd(t.awarded)} + accepted changes ${usd(t.accepted_changes)}`,
      ],
      [
        "Certified, unpaid",
        t.outstanding,
        "Approved applications less net recorded payments",
      ],
      [
        "Payments recorded",
        t.paid,
        "External payments, less recorded reversals",
      ],
      [
        "Retainage held",
        t.retainage,
        latest
          ? `Cumulative · through ${dateLabel(latest.period_to)}`
          : "No application approved yet",
      ],
    ]) +
    `<div class="billing-notice"><div><strong>Billing records · USD</strong><p>No money moves through WorkOrder. Payment references document transactions made elsewhere. ${!can.payer && !can.contractor ? "You have a read-only view as the project client; the immediate contracting parties handle approvals." : ""}</p></div></div>` +
    `<div class="billing-columns"><section>${panel(
      "Progress applications",
      b.applications.length
        ? b.applications
            .slice()
            .reverse()
            .map((a) => {
              const paid = paidFor(b, a.id),
                balance = Math.max(0, Number(a.amount_due) - paid);
              return `<article class="application-card"><div class="panel-heading"><div><span class="eyebrow">PA-${number(a.id)} · ${esc(dateLabel(a.period_from))} – ${esc(dateLabel(a.period_to))}</span><h3>${usd(a.amount_due)}</h3></div>${status(a.status)}</div><p>${a.status === "approved" ? `${usd(paid)} recorded · ${usd(balance)} unpaid` : `Submitted by ${esc(person(b, a.submitted_by_user_id))}`}</p><div class="actions">${link("View application", `application/${a.id}`)}${a.status === "submitted" && can.payer && !can.contractor ? button("Approve", "billing-approve", a.id, "primary") + button("Reject", "billing-reject-application", a.id) : ""}${a.status === "submitted" && can.contractor ? button("Withdraw", "billing-withdraw-application", a.id) : ""}${a.status === "approved" && balance > 0.001 && can.payer && !can.contractor ? button("Record payment", "billing-payment", a.id, "primary") : ""}</div>${a.decided_at ? `<p class="hint">${esc(a.status)} by ${esc(person(b, a.decided_by_user_id))} · ${esc(dateLabel(a.decided_at))}${a.decision_note ? ` · ${esc(a.decision_note)}` : ""}</p>` : ""}</article>`;
            })
            .join("")
        : empty(
            "Make progress count",
            "Prepare an application from this scope’s recorded costs. Review the exact figures before submitting.",
          ),
      can.contractor && !b.applications.some((a) => a.status === "submitted")
        ? button(
            "Prepare application",
            "billing-prepare",
            b.subdivision.id,
            "primary",
          )
        : "",
    )}</section><aside>${panel("Cost basis", `<div class="cost-strip"><span>Recorded labor<strong>${usd(b.costs.labor_cost)}</strong></span><span>Consumed materials<strong>${usd(b.costs.material_cost)}</strong></span></div><p class="hint">All dates · this scope only. Labor uses saved hourly rates; materials use costs saved at consumption. Each application preserves its own period-end source records.</p><hr><span class="eyebrow">Accepted schedule adjustment</span><h3>${t.schedule_days > 0 ? "+" : ""}${t.schedule_days} days</h3><p class="hint">Recorded change to the agreed duration. A dependency schedule is not connected yet.</p>`)}</aside></div>` +
    panel(
      "Change orders",
      b.change_orders.length
        ? b.change_orders
            .slice()
            .reverse()
            .map((co) => {
              const sameSide =
                co.proposed_side === "payer" ? can.payer : can.contractor;
              const otherSide =
                co.proposed_side === "payer" ? can.contractor : can.payer;
              return `<article class="change-card"><div class="panel-heading"><div><span class="eyebrow">CO-${number(co.id)} · ${esc(person(b, co.proposed_by_user_id))} · ${esc(dateLabel(co.created_at))}</span><h3>${esc(co.title)}</h3></div>${status(co.status)}</div><p class="preserve-lines">${esc(co.description)}</p><div class="change-terms"><strong>${Number(co.amount) > 0 ? "+" : ""}${usd(co.amount)}</strong><span>${co.schedule_days > 0 ? "+" : ""}${co.schedule_days} days</span></div>${co.decided_at ? `<p class="hint">${esc(co.status)} by ${esc(person(b, co.decided_by_user_id))} · ${esc(dateLabel(co.decided_at))}${co.decision_note ? ` · ${esc(co.decision_note)}` : ""}</p>` : `<div class="actions">${otherSide && !sameSide ? button("Accept change", "billing-accept-change", co.id, "primary") + button("Reject change", "billing-reject-change", co.id) : ""}${sameSide ? button("Withdraw change", "billing-withdraw-change", co.id) : ""}</div>`}</article>`;
            })
            .join("")
        : empty(
            "Keep scope changes on the record",
            "Either contracting party can propose a priced change. Only the other party can accept it, and only accepted changes affect the contract.",
          ),
      (can.payer || can.contractor) && b.subdivision.status !== "completed"
        ? button("Propose change", "billing-change", b.subdivision.id)
        : "",
    ) +
    panel(
      "Payment history",
      b.payments.length
        ? table(
            [
              "Date / reference",
              "Application",
              "Amount · USD",
              "Recorded by",
              "",
            ],
            b.payments
              .slice()
              .reverse()
              .map((p) =>
                row([
                  `<strong>${esc(p.reference)}</strong><small>${esc(dateLabel(p.paid_on))}</small><small>${esc(p.note)}</small>`,
                  `PA-${number(p.application_id)}`,
                  `${p.reverses_payment_id ? "−" : ""}${money(p.amount)}${p.reverses_payment_id ? "<small>Record reversal</small>" : ""}`,
                  `${esc(person(b, p.recorded_by_user_id))}<small>Entered ${esc(dateLabel(p.created_at))}</small>`,
                  !p.reverses_payment_id &&
                  !b.payments.some((r) => r.reverses_payment_id === p.id) &&
                  can.payer &&
                  !can.contractor
                    ? button("Reverse record", "billing-reverse", p.id)
                    : "—",
                ]),
              ),
          )
        : '<p class="muted">No payments recorded. Approve an application before recording an external payment.</p>',
    )
  );
}
export async function renderApplication(c, id) {
  const b = (c.data.billing = await api(`/pay-applications/${id}`));
  const a = b.applications.find((a) => a.id === Number(id));
  const s = a.snapshot;
  return `<div class="no-print"><a class="back" href="#billing/${b.subdivision.id}">← Scope billing</a></div><article class="application-document">${heading(`Pay application · PA-${number(a.id)} · ${a.status}`, s.project, s.scope, `<div class="actions no-print">${button("Print / Save PDF", "billing-print", a.id)}${button("Export CSV", "billing-export", a.id)}</div>`)}<div class="document-parties"><div><span class="eyebrow">Paying party</span><strong>${esc(s.payer)}</strong></div><div><span class="eyebrow">Contractor</span><strong>${esc(s.contractor)}</strong></div><div><span class="eyebrow">Billing period · USD</span><strong>${esc(dateLabel(a.period_from))} – ${esc(dateLabel(a.period_to))}</strong></div></div>${applicationNumbers(s)}<p>Submitted by ${esc(person(b, a.submitted_by_user_id))} · ${esc(dateLabel(a.created_at))}</p>${a.decided_at ? `<p>${esc(a.status)} by ${esc(person(b, a.decided_by_user_id))} · ${esc(dateLabel(a.decided_at))} · ${esc(a.decision_note)}</p>` : ""}<hr><h2>Supporting records</h2><p class="hint">Source snapshot at submission. Includes all recorded costs through the period end; child scopes are billed separately. Material date cutoff uses UTC. Later corrections do not rewrite this application.</p>${table(
    ["Labor date", "Worker", "Hours", "Saved rate · USD/h", "Cost · USD"],
    s.sources.labor.map((r) =>
      row([
        esc(r.date),
        esc(r.full_name),
        esc(r.hours),
        money(r.hourly_rate),
        money(r.cost),
      ]),
    ),
  )}${table(
    ["Consumed", "Material", "Quantity", "Saved unit cost · USD", "Cost · USD"],
    s.sources.materials.map((r) =>
      row([
        esc(dateLabel(r.consumed_at)),
        esc(r.item_name),
        esc(r.qty),
        money(r.unit_cost),
        money(r.cost),
      ]),
    ),
  )}${
    s.sources.change_orders.length
      ? table(
          ["Accepted change", "Price delta · USD", "Schedule delta"],
          s.sources.change_orders.map((r) =>
            row([
              `CO-${number(r.id)} · ${esc(r.title)}`,
              money(r.amount),
              `${r.schedule_days} days`,
            ]),
          ),
        )
      : ""
  }<p class="document-footer">WorkOrder · Billing record in USD. This document does not confirm a bank transfer, escrow balance, or lien waiver.</p></article>`;
}
export async function billingAction(c, name, id) {
  const b = c.data.billing;
  const done = async (path, data, method = "POST") => {
    await write(path, data, method);
    toast("Billing record saved");
    await c.reload();
  };
  if (name === "billing-change")
    return modal(
      "Propose a change order",
      field("Title", "title", "text", "", 'required maxlength="200"') +
        textarea(
          "Added or removed work",
          "description",
          "",
          'required maxlength="10000"',
        ) +
        field(
          "Price change · USD (negative reduces price)",
          "amount",
          "number",
          "",
          'required min="-9999999999.99" max="9999999999.99" step="0.01"',
        ) +
        field(
          "Schedule change · days (negative shortens duration)",
          "schedule_days",
          "number",
          0,
          'required min="-3660" max="3660" step="1"',
        ) +
        '<p class="hint">The price and duration change only when the other contracting party accepts. The original scope and bid stay on the record.</p>',
      (v) =>
        done(`/subdivisions/${id}/changes`, {
          ...v,
          amount: Number(v.amount),
          schedule_days: Number(v.schedule_days),
        }),
      "Send proposal",
    );
  const decisions = {
    "billing-accept-change": ["changes", "accepted", "Accept change"],
    "billing-reject-change": ["changes", "rejected", "Reject change"],
    "billing-withdraw-change": ["changes", "withdrawn", "Withdraw change"],
    "billing-approve": ["pay-applications", "approved", "Approve application"],
    "billing-reject-application": [
      "pay-applications",
      "rejected",
      "Reject application",
    ],
    "billing-withdraw-application": [
      "pay-applications",
      "withdrawn",
      "Withdraw application",
    ],
  };
  if (decisions[name]) {
    const [path, result, title] = decisions[name];
    const record = (path === "changes" ? b.change_orders : b.applications).find(
      (r) => r.id === id,
    );
    return modal(
      title,
      `<p>${path === "changes" ? `${esc(record.title)} · ${usd(record.amount)} · ${record.schedule_days} days` : `PA-${number(id)} · ${usd(record.amount_due)}${result === "approved" ? ". Approval certifies this amount; it does not send a payment." : ""}`}</p>` +
        textarea(
          "Decision note",
          "note",
          "",
          `maxlength="4000" ${result === "rejected" ? "required" : ""}`,
        ),
      (v) => done(`/${path}/${id}`, { status: result, note: v.note }, "PATCH"),
      title,
    );
  }
  if (name === "billing-prepare") {
    const previous = b.applications
      .filter((a) => a.status === "approved")
      .at(-1);
    let prepared;
    const fields =
      field(
        "Period from",
        "from",
        "date",
        previous ? nextDay(previous.period_to) : today().slice(0, 8) + "01",
        "required",
      ) +
      field("Period to", "to", "date", today(), `required max="${today()}"`) +
      field(
        "Stored materials not yet consumed · USD",
        "stored_materials",
        "number",
        "0",
        'required min="0" max="9999999999.99" step="0.01"',
      ) +
      field(
        "Retainage · percent",
        "retainage_percent",
        "number",
        previous?.snapshot.retainage_percent ?? 5,
        'required min="0" max="100" step="1"',
      ) +
      '<p class="hint">Recorded labor and consumed materials are calculated through the period end. Enter only the value still stored, excluding any materials already consumed. Keep the agreed retainage rate; enter 0 on a completed scope to request its release.</p>';
    return modal(
      "Prepare progress application",
      `<div id="application-inputs">${fields}</div><div id="application-preview" hidden></div>`,
      async (v) => {
        if (prepared)
          return done(`/subdivisions/${id}/pay-applications`, prepared);
        const data = {
          from: v.from,
          to: v.to,
          stored_materials: Number(v.stored_materials),
          retainage_percent: Number(v.retainage_percent),
        };
        const preview = await write(
          `/subdivisions/${id}/pay-applications/preview`,
          data,
        );
        prepared = { ...data, expected: preview.fingerprint };
        const dialog = document.querySelector("#modal");
        dialog.querySelector("#application-inputs").hidden = true;
        const output = dialog.querySelector("#application-preview");
        output.hidden = false;
        output.innerHTML = `<p class="eyebrow">Review · ${esc(dateLabel(v.from))} – ${esc(dateLabel(v.to))}</p>${applicationNumbers(preview.snapshot)}<button class="btn secondary" type="button" id="application-edit">Edit details</button>`;
        dialog.querySelector('[type="submit"]').textContent =
          "Submit application";
        dialog.querySelector("#application-edit").onclick = () => {
          prepared = null;
          output.hidden = true;
          dialog.querySelector("#application-inputs").hidden = false;
          dialog.querySelector('[type="submit"]').textContent =
            "Review figures";
        };
        return false;
      },
      "Review figures",
    );
  }
  if (name === "billing-payment") {
    const a = b.applications.find((r) => r.id === id);
    const balance = Math.max(0, Number(a.amount_due) - paidFor(b, id));
    const request_key = crypto.randomUUID();
    return modal(
      "Record an external payment",
      `<p>PA-${number(id)} · ${usd(balance)} unpaid. Record a payment already made outside WorkOrder.</p>` +
        field(
          "Amount · USD",
          "amount",
          "number",
          balance.toFixed(2),
          `required min="0.01" max="${balance.toFixed(2)}" step="0.01"`,
        ) +
        field(
          "Payment date",
          "paid_on",
          "date",
          today(),
          `required max="${today()}"`,
        ) +
        field(
          "Bank or check reference",
          "reference",
          "text",
          "",
          'required maxlength="200"',
        ) +
        textarea("Note", "note", "", 'maxlength="4000"'),
      (v) =>
        done(`/pay-applications/${id}/payments`, {
          ...v,
          amount: Number(v.amount),
          request_key,
        }),
      "Record payment",
    );
  }
  if (name === "billing-reverse") {
    const p = b.payments.find((r) => r.id === id);
    const request_key = crypto.randomUUID();
    return modal(
      "Reverse a payment record",
      `<p>${esc(p.reference)} · ${usd(p.amount)}. This preserves the original record and restores the unpaid balance. It does not refund or move money.</p>` +
        textarea(
          "Reason for correction",
          "note",
          "",
          'required maxlength="4000"',
        ),
      (v) => done(`/billing-payments/${id}/reversal`, { ...v, request_key }),
      "Reverse record",
    );
  }
  if (name === "billing-print") return window.print();
  if (name === "billing-export") {
    const a = b.applications.find((r) => r.id === id),
      s = a.snapshot;
    const rows = [
      ["WorkOrder pay application", `PA-${number(id)}`],
      ["Status", a.status],
      ["Project", s.project],
      ["Scope", s.scope],
      ["Payer", s.payer],
      ["Contractor", s.contractor],
      ["Currency", "USD"],
      ["Period from", a.period_from],
      ["Period to", a.period_to],
      ...[
        "contract_value",
        "labor_cost",
        "material_cost",
        "stored_materials",
        "gross",
        "retainage",
        "previous_certified",
        "previous_payments",
        "amount_due",
      ].map((key) => [key, s[key]]),
      [],
      ["Labor date", "Worker", "Hours", "Saved rate USD", "Cost USD"],
      ...s.sources.labor.map((r) => [
        r.date,
        r.full_name,
        r.hours,
        r.hourly_rate,
        r.cost,
      ]),
      [],
      ["Material", "Quantity", "Saved unit cost USD", "Cost USD"],
      ...s.sources.materials.map((r) => [
        r.item_name,
        r.qty,
        r.unit_cost,
        r.cost,
      ]),
    ];
    const cell = (v) =>
      `"${String(v ?? "")
        .replace(/^[=+\-@\t\r]/, "'$&")
        .replaceAll('"', '""')}"`;
    const url = URL.createObjectURL(
      new Blob(
        ["\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n")],
        { type: "text/csv;charset=utf-8" },
      ),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `WorkOrder-PA-${number(id)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
