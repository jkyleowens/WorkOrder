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
// Settled = external payment records plus in-flight or completed Stripe releases, net of reversals.
const paidFor = (b, id) =>
  b.payments
    .filter((p) => p.application_id === id)
    .reduce(
      (n, p) => n + (p.reverses_payment_id ? -1 : 1) * Number(p.amount),
      0,
    ) +
  (b.releases || [])
    .filter(
      (r) =>
        r.application_id === id &&
        ["processing", "paid", "reversed"].includes(r.status),
    )
    .reduce((n, r) => n + Number(r.amount) - Number(r.amount_reversed), 0);
const hashQuery = () => new URLSearchParams(location.hash.split("?")[1] || "");
const redirect = (url) => {
  // Stripe-hosted pages are the only external destinations; never follow anything else.
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    !/(^|\.)stripe\.com$/.test(target.hostname)
  )
    throw new Error("Unexpected payment redirect");
  location.assign(target.href);
};
const fundingTable = (f, can) =>
  table(
    [
      "Funding",
      "Amount · USD",
      "Status",
      "Confirmed · USD",
      "Awaiting release · USD",
      "",
    ],
    f.fundings
      .slice()
      .reverse()
      .map((x) =>
        row([
          `<strong>F-${number(x.id)}</strong><small>${esc(dateLabel(x.created_at))}</small>`,
          money(x.amount),
          `${status(x.status)}${x.provider_dispute_status ? `<small>Card dispute · ${esc(x.provider_dispute_status)}</small>` : ""}${x.failure_message ? `<small>${esc(x.failure_message)}</small>` : ""}`,
          money(x.amount_received),
          money(x.available),
          `<div class="actions">${x.checkout_url ? `<a class="btn primary" href="${esc(x.checkout_url)}" rel="noopener">Continue checkout</a>` : ""}${["pending", "processing"].includes(x.status) ? button("Refresh status", "billing-funding-refresh", x.id) : ""}${can.payer && !can.contractor && Number(x.available) > 0 ? button("Refund unreleased", "billing-refund", x.id) : ""}</div>`,
        ]),
      ),
  );
const fundingPanel = (b, f) => {
  if (!f.configured)
    return `<div class="billing-notice"><div><strong>Online funding is not enabled on this server</strong><p>Scopes cannot be funded or released through WorkOrder until Stripe keys are configured. You can still record payments made elsewhere.</p></div></div>`;
  const can = f.permissions,
    t = f.totals;
  const open = f.fundings.find((x) =>
    ["pending", "processing"].includes(x.status),
  );
  const remaining = Math.max(
    0,
    Number(b.totals.contract_value) - Number(t.funded) + Number(t.refunded),
  );
  const onboarding = f.contractor_account.transfers_active
    ? ""
    : can.contractor
      ? `<div class="billing-notice"><div><strong>Set up payouts to receive released funds</strong><p>Stripe verifies your identity and bank account. Releases stay unavailable until onboarding is complete.</p></div>${link("Set up payouts", "billing/payouts", "primary")}</div>`
      : '<p class="hint">The contractor has not finished Stripe payout onboarding. Funds can be deposited now; releases become available once they finish.</p>';
  return panel(
    `Scope funding${f.live ? "" : " · Stripe test mode"}`,
    metrics([
      ["Funded", t.funded, "Payments confirmed by Stripe"],
      [
        "Awaiting release",
        t.available,
        Number(t.held) || Number(t.disputed)
          ? `Held ${usd(t.held)} · card disputes ${usd(t.disputed)}`
          : "Funded, not yet released or refunded",
      ],
      [
        "Released",
        t.released,
        Number(t.releasing)
          ? `${usd(t.releasing)} processing`
          : "Transferred to the contractor’s payout balance",
      ],
      ["Refunded", t.refunded, "Returned to the paying party"],
    ]) +
      onboarding +
      (Number(t.pending)
        ? `<p class="hint">${usd(t.pending)} is awaiting payment confirmation from Stripe. Returning from checkout does not by itself confirm payment.</p>`
        : "") +
      (f.fundings.length
        ? fundingTable(f, can)
        : '<p class="muted">No funding yet. The paying party deposits funds against this scope; they are released to the contractor against approved applications.</p>') +
      (f.releases.length
        ? `<h3>Releases</h3>${table(
            ["Application", "Amount · USD", "Status", "Detail", ""],
            f.releases
              .slice()
              .reverse()
              .map((r) =>
                row([
                  `<strong>PA-${number(r.application_id)}</strong><small>${esc(dateLabel(r.created_at))} · from F-${number(r.funding_id)}</small>`,
                  `${money(r.amount)}${Number(r.amount_reversed) ? `<small>${money(r.amount_reversed)} reversed</small>` : ""}`,
                  status(r.status),
                  esc(
                    r.failure_message ||
                      (r.status === "paid"
                        ? "In contractor’s Stripe balance"
                        : "—"),
                  ),
                  r.status === "processing" && can.payer && !can.contractor
                    ? button("Retry release", "billing-release-retry", r.id)
                    : "—",
                ]),
              ),
          )}`
        : "") +
      (f.refunds.length
        ? `<h3>Refunds</h3>${table(
            ["Funding", "Amount · USD", "Status", "Reason"],
            f.refunds.map((r) =>
              row([
                `F-${number(r.funding_id)}<small>${esc(dateLabel(r.created_at))}</small>`,
                money(r.amount),
                status(r.status),
                esc(r.failure_message || r.reason),
              ]),
            ),
          )}`
        : ""),
    can.payer && !can.contractor && !open && remaining > 0.001
      ? button("Fund scope", "billing-fund", b.subdivision.id, "primary")
      : "",
  );
};
const waiverRows = (waivers, can, showScope = false) =>
  table(
    [
      "Waiver",
      ...(showScope ? ["Work package"] : []),
      "Amount · USD",
      "Through",
      "Status",
      "",
    ],
    waivers.map((w) =>
      row([
        `<strong>LW-${number(w.id)}</strong><small>${esc(w.snapshot.title)}</small><small>PA-${number(w.application_id)} · ${esc(w.snapshot.claimant)}</small>`,
        ...(showScope ? [esc(w.snapshot.scope)] : []),
        money(w.amount),
        esc(dateLabel(w.through_date)),
        `${status(w.status)}${w.status === "signed" ? `<small>${esc(w.signer_name)} · ${esc(dateLabel(w.signed_at))}</small>` : w.status === "void" ? `<small>${esc(w.void_reason)}</small>` : "<small>Awaiting signature</small>"}`,
        `<div class="actions">${link("View waiver", `waiver/${w.id}`)}${can?.contractor && !can?.payer && w.status === "requested" ? button("Sign waiver", "billing-sign-waiver", w.id, "primary") : ""}</div>`,
      ]),
    ),
  );
const waiverPanel = (b, waivers) =>
  panel(
    "Lien waivers",
    (waivers.length
      ? waiverRows(waivers, b.permissions)
      : '<p class="muted">A conditional waiver is requested when an application is submitted, and an unconditional waiver once its payment clears.</p>') +
      '<p class="hint">Only the contractor on this scope signs its waivers. A signed conditional waiver is required before funds are released through Stripe. Signed waivers cannot be edited.</p>',
    link("Project waiver chain", `waivers/${b.project.id}`),
  );
export async function renderWaiver(c, id) {
  const data = await api(`/waivers/${id}`);
  const w = data.waiver,
    s = w.snapshot;
  return `<div class="no-print"><a class="back" href="#billing/${w.subdivision_id}">← Scope billing</a></div><article class="application-document waiver-document">${heading(
    `Lien waiver · LW-${number(w.id)} · ${w.status}`,
    s.title,
    `${s.project} · ${s.scope}`,
    `<div class="actions no-print">${button("Print / Save PDF", "billing-print", w.id)}${data.permissions.contractor && !data.permissions.payer && w.status === "requested" ? button("Sign waiver", "billing-sign-waiver", w.id, "primary") : ""}</div>`,
  )}<div class="document-parties"><div><span class="eyebrow">Claimant</span><strong>${esc(s.claimant)}</strong></div><div><span class="eyebrow">Paying party</span><strong>${esc(s.payer)}</strong></div><div><span class="eyebrow">Project client</span><strong>${esc(s.owner)}</strong></div><div><span class="eyebrow">Amount</span><strong>${usd(s.amount)}</strong></div><div><span class="eyebrow">Through</span><strong>${esc(dateLabel(s.through_date))}</strong></div><div><span class="eyebrow">Pay application</span><strong>PA-${number(s.application_id)}</strong></div></div><div class="waiver-text">${s.text.map((p) => `<p>${esc(p)}</p>`).join("")}</div><h2>Exceptions</h2><p class="preserve-lines">${esc(w.exceptions || (w.status === "signed" ? "None" : "Stated by the claimant when signing"))}</p><section class="signature-block">${
    w.status === "signed"
      ? `<span class="eyebrow">Signed</span><strong>${esc(w.signer_name)}${w.signer_title ? ` · ${esc(w.signer_title)}` : ""}</strong><p>${esc(new Date(w.signed_at).toLocaleString())} · recorded by WorkOrder account ${esc(data.signer)}</p><p class="hash">Record fingerprint SHA-256 ${esc(w.content_hash)}</p>`
      : w.status === "void"
        ? `<span class="eyebrow">Void</span><p>${esc(w.void_reason)}. This waiver can no longer be signed.</p>`
        : '<span class="eyebrow">Awaiting signature</span><p>Not signed. This waiver has no effect until the claimant signs it.</p>'
  }</section><p class="document-footer">WorkOrder · Lien waiver record. Electronic signature recorded with account, name, time and a fingerprint of the signed content. Not a jurisdiction-specific statutory form.</p></article>`;
}
export async function renderWaiverChain(c, projectId) {
  const chain = await api(`/projects/${projectId}/waivers`);
  const count = (state) =>
    chain.waivers.filter((w) => w.status === state).length;
  const depth = (scope) => {
    let n = 0,
      parent = scope.parent_subdivision_id;
    while (parent && n < 20) {
      n++;
      parent = chain.scopes.find((s) => s.id === parent)?.parent_subdivision_id;
    }
    return n;
  };
  return (
    `<div class="no-print"><a class="back" href="#project/${chain.project.id}">← Project</a></div>` +
    `<article class="application-document">` +
    heading(
      "Closeout paperwork",
      "Lien waiver chain",
      `${chain.project.title} · every waiver for the work packages you can view, including subcontracts.`,
      `<div class="actions no-print">${button("Print / Save PDF", "billing-print", chain.project.id)}</div>`,
    ) +
    `<div class="stats"><div class="stat"><span>Signed</span><strong>${count("signed")}</strong><small>Recorded signatures</small></div><div class="stat"><span>Awaiting signature</span><strong>${count("requested")}</strong><small>Requested from contractors</small></div><div class="stat"><span>Void</span><strong>${count("void")}</strong><small>Superseded by application or payment changes</small></div></div>` +
    (chain.waivers.length
      ? `<p class="hint">${chain.complete ? "No waivers are awaiting signature." : "The chain is incomplete until every requested waiver is signed."}</p>` +
        chain.scopes
          .map((scope) => {
            const rows = chain.waivers.filter(
              (w) => w.subdivision_id === scope.id,
            );
            return `<section class="waiver-scope ${depth(scope) ? "child-scope" : ""}"><h2>${depth(scope) ? "↳ " : ""}${esc(scope.scope)}</h2>${rows.length ? waiverRows(rows, null) : '<p class="muted">No waivers yet for this work package.</p>'}</section>`;
          })
          .join("")
      : empty(
          "No waivers yet",
          "Waivers appear when contractors submit pay applications on awarded work.",
        )) +
    `<p class="document-footer">WorkOrder · Waiver chain generated ${esc(new Date().toLocaleString())}. Includes only work packages visible to your account.</p></article>`
  );
}

async function renderPayouts(c) {
  let result = await api("/payment-accounts");
  if (hashQuery().get("onboarding")) {
    await Promise.all(
      result.accounts.map((a) =>
        write(`/payment-accounts/${a.id}/refresh`).catch(() => null),
      ),
    );
    result = await api("/payment-accounts");
    history.replaceState(null, "", "#billing/payouts");
  }
  c.data.accounts = result.accounts;
  const owners = [
    { org: null, name: `${c.user.full_name} · independent work` },
    ...c.memberships
      .filter((m) => c.manages(m.org_id))
      .map((m) => ({ org: m.org_id, name: m.organization.name })),
  ];
  return (
    `<a class="back" href="#billing">← Billing</a>` +
    heading(
      `Payouts${result.live ? "" : " · Stripe test mode"}`,
      "Get paid for released work",
      "Released funds land in your Stripe payout balance. You choose when to pay out to your bank.",
    ) +
    (result.configured
      ? ""
      : `<div class="billing-notice"><div><strong>Online payouts are not enabled on this server</strong><p>Stripe keys have not been configured, so payout onboarding is unavailable.</p></div></div>`) +
    owners
      .map(({ org, name }) => {
        const a = result.accounts.find((x) =>
          org ? x.owner_org_id === org : x.owner_user_id === c.user.id,
        );
        const state = !a
          ? "inactive"
          : a.transfers_active && a.payouts_enabled
            ? "active"
            : "onboarding";
        const deadline = a?.aging?.next_deadline;
        return panel(
          name,
          `<p>${status(state)}</p>` +
            (a
              ? `<div class="cost-strip"><span>Available to pay out<strong>${a.balance ? usd(a.balance.available) : "—"}</strong></span><span>Pending at Stripe<strong>${a.balance ? usd(a.balance.pending) : "—"}</strong></span></div>` +
                `<p class="hint">${a.requirements.length ? `Stripe needs ${a.requirements.length} more item${a.requirements.length === 1 ? "" : "s"} before payouts are enabled.` : a.payouts_enabled ? "Verified by Stripe for payouts." : "Onboarding in progress."} Status checked ${esc(dateLabel(a.updated_at))}.</p>` +
                (deadline
                  ? `<p class="hint">${usd(a.aging.remaining)} of recorded releases remains unpaid to the bank. The oldest funds are due by ${esc(dateLabel(deadline))}. Partial payouts pay down the oldest recorded releases first.</p>`
                  : "") +
                (a.aging?.needs_reconciliation
                  ? '<p role="alert">Payout and reversal records need reconciliation. Review the ledger before relying on these deadlines.</p>'
                  : "") +
                (a.payouts.length
                  ? table(
                      ["Requested", "Amount · USD", "Status", "Detail"],
                      a.payouts.map((p) =>
                        row([
                          esc(dateLabel(p.created_at)),
                          money(p.amount),
                          status(p.status),
                          esc(p.failure_message || "—"),
                        ]),
                      ),
                    )
                  : '<p class="muted">No payouts yet.</p>')
              : '<p class="muted">Set up a Stripe payout account to receive released funds for this party’s awarded work.</p>'),
          `<div class="actions">${
            !a || !a.transfers_active || !a.payouts_enabled
              ? button(
                  a ? "Continue onboarding" : "Set up payouts",
                  "billing-onboard",
                  org || "",
                  "primary",
                )
              : ""
          }${a ? button("Refresh status", "billing-account-refresh", a.id) : ""}${
            a?.payouts_enabled && Number(a.balance?.available) > 0
              ? button("Pay out", "billing-payout", a.id, "primary")
              : ""
          }</div>`,
        );
      })
      .join("")
  );
}
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
  if (part === "holding") {
    const accounts = await api("/admin/payout-holding");
    return (
      heading(
        "Administration",
        "Payout holding deadlines",
        "Recorded bank payouts are applied to the oldest eligible releases. Pending and failed payouts do not clear deadlines.",
      ) +
      '<p class="hint">This tracks WorkOrder releases and payouts. Reconcile fees, bank activity and payments made directly in Stripe separately. Reversed funds already paid out are flagged for review.</p>' +
      table(
        [
          "Account",
          "Country",
          "Release / scope",
          "Remaining · USD",
          "Due",
          "Status",
        ],
        accounts.flatMap((a) =>
          a.lots.map((l) =>
            row([
              esc(
                a.owner_org_id
                  ? `Organization ${a.owner_org_id}`
                  : `User ${a.owner_user_id}`,
              ),
              esc(a.country),
              link(
                `Release ${l.release_id} · scope ${l.subdivision_id}`,
                `billing/${l.subdivision_id}`,
              ),
              money(l.remaining),
              esc(dateLabel(l.deadline)),
              esc(l.urgency.replace("_", " ")),
            ]),
          ),
        ),
      ) +
      accounts
        .filter((a) => a.needs_reconciliation)
        .map(
          (a) =>
            `<p role="alert">Account ${a.id}: ${usd(a.unmatched_payouts)} unmatched payouts; ${usd(a.reversed_after_payout)} reversed after payout. Reconciliation required.</p>`,
        )
        .join("")
    );
  }
  if (part === "payouts") return renderPayouts(c);
  if (!part) {
    const rows = await api(`/billing?limit=20&offset=${page * 20}`);
    c.data.billingRows = rows;
    return (
      heading(
        "Commercial workspace · USD",
        "Keep the work and the money connected",
        "Review scope changes, certify progress and track payments in one place.",
        `<div class="actions">${link("Payouts", "billing/payouts")}${c.user.platform_role === "admin" ? link("Holding deadlines", "billing/holding") : ""}${link("Your projects", "projects/mine")}</div>`,
      ) +
      `<div class="billing-notice"><span class="square-icon">↗</span><div><strong>From agreed scope to a clear payment record</strong><p>Applications use recorded labor and materials. Paying parties can fund a scope through Stripe and release funds against approved applications; external payment records document transactions made elsewhere.</p></div></div>` +
      (rows.length
        ? panel(
            "Awarded work",
            table(
              [
                "Project / work package",
                "Amended price · USD",
                "Funded · USD",
                "Unpaid certified · USD",
                "To review",
                "",
              ],
              rows.map((r) =>
                row([
                  `<strong>${esc(r.project_title)}</strong><small>${esc(r.scope)}</small><small>${esc(r.contractor_name)}${r.parent_subdivision_id ? " · Subcontract" : " · Direct contract"}</small>`,
                  money(Number(r.awarded) + Number(r.accepted_changes)),
                  `${money(r.funded)}<small>${money(r.released)} released</small>`,
                  money(
                    Number(r.certified) - Number(r.paid) - Number(r.released),
                  ),
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
  const returned = Number(hashQuery().get("funding"));
  if (returned) {
    // Returning from Checkout only prompts reconciliation; the server re-reads Stripe's state.
    await write(`/fundings/${returned}/refresh`).catch(() => null);
    history.replaceState(null, "", `#billing/${part}`);
  }
  const [b, f, waivers] = await Promise.all([
    api(`/subdivisions/${part}/billing`),
    api(`/subdivisions/${part}/funding`),
    api(`/subdivisions/${part}/waivers`),
  ]);
  c.data.billing = b;
  c.data.funding = f;
  c.data.waivers = waivers;
  const t = b.totals,
    can = b.permissions;
  const latest = b.applications.filter((a) => a.status === "approved").at(-1);
  return (
    `<a class="back" href="#billing">← Billing</a>` +
    heading(
      `${b.project.title} · ${b.subdivision.parent_subdivision_id ? "Subcontract" : "Direct contract"}`,
      b.subdivision.scope,
      `${b.payer_name} → ${b.contractor_name}`,
      link("View project", `project/${b.project.id}`) +
        link("Reviews & disputes", `scope-trust/${part}`),
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
        "Approved applications less releases and recorded payments",
      ],
      [
        "Payments recorded",
        t.paid,
        `External payments, less reversals · ${usd(t.released)} released via Stripe`,
      ],
      [
        "Retainage held",
        t.retainage,
        latest
          ? `Cumulative · through ${dateLabel(latest.period_to)}`
          : "No application approved yet",
      ],
    ]) +
    `<div class="billing-notice"><div><strong>Billing records · USD</strong><p>${f.configured ? "Funding and releases below move money through Stripe. External payment records only document transactions made elsewhere." : "No money moves through WorkOrder on this server. Payment references document transactions made elsewhere."} ${!can.payer && !can.contractor ? "You have a read-only view as the project client; the immediate contracting parties handle approvals." : ""}</p></div></div>` +
    fundingPanel(b, f) +
    `<div class="billing-columns"><section>${panel(
      "Progress applications",
      b.applications.length
        ? b.applications
            .slice()
            .reverse()
            .map((a) => {
              const paid = paidFor(b, a.id),
                balance = Math.max(0, Number(a.amount_due) - paid);
              return `<article class="application-card"><div class="panel-heading"><div><span class="eyebrow">PA-${number(a.id)} · ${esc(dateLabel(a.period_from))} – ${esc(dateLabel(a.period_to))}</span><h3>${usd(a.amount_due)}</h3></div>${status(a.status)}</div><p>${a.status === "approved" ? `${usd(paid)} settled · ${usd(balance)} unpaid` : `Submitted by ${esc(person(b, a.submitted_by_user_id))}`}</p><div class="actions">${link("View application", `application/${a.id}`)}${a.status === "submitted" && can.payer && !can.contractor ? button("Approve", "billing-approve", a.id, "primary") + button("Reject", "billing-reject-application", a.id) : ""}${a.status === "submitted" && can.contractor ? button("Withdraw", "billing-withdraw-application", a.id) : ""}${a.status === "approved" && balance > 0.001 && can.payer && !can.contractor && f.configured ? button("Release funds", "billing-release", a.id, "primary") : ""}${a.status === "approved" && balance > 0.001 && can.payer && !can.contractor ? button("Record payment", "billing-payment", a.id, f.configured ? "secondary" : "primary") : ""}</div>${a.decided_at ? `<p class="hint">${esc(a.status)} by ${esc(person(b, a.decided_by_user_id))} · ${esc(dateLabel(a.decided_at))}${a.decision_note ? ` · ${esc(a.decision_note)}` : ""}</p>` : ""}</article>`;
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
    )}${waiverPanel(b, waivers)}</section><aside>${panel("Cost basis", `<div class="cost-strip"><span>Recorded labor<strong>${usd(b.costs.labor_cost)}</strong></span><span>Consumed materials<strong>${usd(b.costs.material_cost)}</strong></span></div><p class="hint">All dates · this scope only. Labor uses saved hourly rates; materials use costs saved at consumption. Each application preserves its own period-end source records.</p><hr><span class="eyebrow">Accepted schedule adjustment</span><h3>${t.schedule_days > 0 ? "+" : ""}${t.schedule_days} days</h3><p class="hint">Recorded change to the agreed duration. A dependency schedule is not connected yet.</p>`)}</aside></div>` +
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
  const done = async (
    path,
    data,
    method = "POST",
    message = "Billing record saved",
  ) => {
    await write(path, data, method);
    toast(message);
    await c.reload();
  };
  if (name === "billing-fund") {
    const f = c.data.funding;
    const remaining = Math.max(
      0,
      Number(b.totals.contract_value) -
        Number(f.totals.funded) +
        Number(f.totals.refunded),
    );
    const request_key = crypto.randomUUID();
    return modal(
      "Fund this scope",
      `<p>${esc(b.subdivision.scope)} · amended price ${usd(b.totals.contract_value)}. Up to ${usd(remaining)} can still be funded.</p>` +
        field(
          "Funding amount · USD",
          "amount",
          "number",
          remaining.toFixed(2),
          `required min="0.50" max="${Math.min(remaining, 999999.99).toFixed(2)}" step="0.01"`,
        ) +
        '<p class="hint">You will pay on Stripe Checkout. Funds show as funded only after Stripe confirms the payment, stay on this scope until you release them against an approved application, and unreleased funds can be refunded.</p>',
      async (v) => {
        const funding = await write(`/subdivisions/${id}/fundings`, {
          amount: Number(v.amount),
          request_key,
        });
        if (!funding.checkout_url)
          throw new Error(
            "Checkout could not be opened. Refresh and try again.",
          );
        redirect(funding.checkout_url);
        return false;
      },
      "Continue to payment",
    );
  }
  if (name === "billing-sign-waiver") {
    const w =
      (c.data.waivers || []).find((x) => x.id === id) ||
      (await api(`/waivers/${id}`)).waiver;
    return modal(
      "Sign lien waiver",
      `<p class="eyebrow">LW-${number(w.id)} · ${esc(w.snapshot.title)} · ${usd(w.amount)}</p><div class="waiver-text">${w.snapshot.text.map((p) => `<p>${esc(p)}</p>`).join("")}</div>` +
        field(
          "Your full name",
          "signer_name",
          "text",
          c.user.full_name,
          'required minlength="2" maxlength="120" autocomplete="name"',
        ) +
        field("Title or role", "signer_title", "text", "", 'maxlength="120"') +
        textarea(
          "Exceptions (optional)",
          "exceptions",
          "",
          'maxlength="4000"',
        ) +
        `<label class="confirm-check"><input type="checkbox" name="confirm" required> I am authorized to sign for ${esc(w.snapshot.claimant)}${w.conditional ? "" : ", and this payment has been received"}.</label>` +
        '<p class="hint">Your name, account, the time and a fingerprint of this exact text are recorded. A signed waiver cannot be changed.</p>',
      async (v) => {
        await write(`/waivers/${id}/sign`, {
          signer_name: v.signer_name,
          signer_title: v.signer_title,
          exceptions: v.exceptions,
          confirm: v.confirm === "on",
        });
        toast("Lien waiver signed");
        await c.reload();
      },
      "Sign waiver",
    );
  }
  if (name === "billing-funding-refresh")
    return done(
      `/fundings/${id}/refresh`,
      {},
      "POST",
      "Funding status refreshed",
    );
  if (name === "billing-refund") {
    const funding = c.data.funding.fundings.find((x) => x.id === id);
    const request_key = crypto.randomUUID();
    return modal(
      "Refund unreleased funding",
      `<p>F-${number(id)} · ${usd(funding.available)} awaiting release. Released funds cannot be refunded here.</p>` +
        field(
          "Refund amount · USD",
          "amount",
          "number",
          Number(funding.available).toFixed(2),
          `required min="0.50" max="${Number(funding.available).toFixed(2)}" step="0.01"`,
        ) +
        textarea("Reason", "reason", "", 'required maxlength="2000"') +
        '<p class="hint">Stripe returns the refund to the original payment method. It shows as refunded once Stripe confirms it.</p>',
      (v) =>
        done(
          `/fundings/${id}/refunds`,
          { amount: Number(v.amount), reason: v.reason, request_key },
          "POST",
          "Refund requested",
        ),
      "Request refund",
    );
  }
  if (name === "billing-release") {
    const f = c.data.funding;
    const a = b.applications.find((r) => r.id === id);
    const balance = Math.max(0, Number(a.amount_due) - paidFor(b, id));
    const suggested = Math.min(balance, Number(f.totals.available));
    const request_key = crypto.randomUUID();
    if (
      !c.data.waivers.some(
        (w) =>
          w.application_id === id && w.conditional && w.status === "signed",
      )
    )
      return modal(
        "Release funds",
        empty(
          "Waiting for the signed conditional lien waiver",
          "The contractor signs the conditional waiver for this application before funds can be released.",
        ),
        null,
      );
    if (!f.contractor_account.transfers_active)
      return modal(
        "Release funds",
        empty(
          "The contractor cannot receive funds yet",
          "They need to finish Stripe payout onboarding. Releases become available as soon as they do.",
        ),
        null,
      );
    return modal(
      "Release funds to the contractor",
      `<p>PA-${number(id)} · ${usd(balance)} certified and unpaid · ${usd(f.totals.available)} funded and awaiting release.</p>` +
        field(
          "Release amount · USD",
          "amount",
          "number",
          suggested.toFixed(2),
          `required min="0.50" max="${suggested.toFixed(2)}" step="0.01"`,
        ) +
        '<p class="hint">This transfers money to the contractor’s Stripe payout balance and cannot be undone from WorkOrder. Retainage stays funded until a closeout application releases it.</p>',
      (v) =>
        done(
          `/subdivisions/${b.subdivision.id}/releases`,
          { application_id: id, amount: Number(v.amount), request_key },
          "POST",
          "Funds released",
        ),
      "Release funds",
    );
  }
  if (name === "billing-release-retry")
    return done(`/releases/${id}/retry`, {}, "POST", "Release retried");
  if (name === "billing-onboard") {
    const result = await write("/payment-accounts", id ? { org_id: id } : {});
    return redirect(result.url);
  }
  if (name === "billing-account-refresh")
    return done(
      `/payment-accounts/${id}/refresh`,
      {},
      "POST",
      "Payout status refreshed",
    );
  if (name === "billing-payout") {
    const account = c.data.accounts.find((a) => a.id === id);
    const request_key = crypto.randomUUID();
    return modal(
      "Pay out to your bank",
      `<p>${usd(account.balance.available)} available in your Stripe payout balance.</p>` +
        field(
          "Payout amount · USD",
          "amount",
          "number",
          Number(account.balance.available).toFixed(2),
          `required min="0.50" max="${Number(account.balance.available).toFixed(2)}" step="0.01"`,
        ) +
        '<p class="hint">Stripe sends the payout to the bank account you verified. Arrival usually takes a few business days; the status updates as Stripe reports it.</p>',
      (v) =>
        done(
          `/payment-accounts/${id}/payouts`,
          { amount: Number(v.amount), request_key },
          "POST",
          "Payout requested",
        ),
      "Request payout",
    );
  }
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
