import { api, write } from "./api.js";
import {
  esc,
  heading,
  panel,
  link,
  button,
  status,
  field,
  textarea,
  select,
  modal,
  toast,
  dateLabel,
  money,
} from "./ui.js";
const kinds = [
  ["trade_license", "Trade license"],
  ["general_liability", "General liability"],
  ["workers_compensation", "Workers’ compensation"],
  ["certification", "Certification"],
];
const numeric = 'required min="0" max="9999999999.99" step="0.01"';
const fileField = () =>
  field(
    "Supporting document (PDF, PNG or JPEG)",
    "document",
    "file",
    "",
    'accept="application/pdf,image/png,image/jpeg"',
  );
async function attachment(v) {
  if (!v.document?.size) return {};
  const token = (await api("/auth/csrf")).csrf_token;
  const response = await fetch("/api/files", {
    method: "POST",
    headers: {
      "X-CSRF-Token": token,
      "Content-Type": v.document.type,
      "X-Filename": encodeURIComponent(v.document.name),
    },
    body: v.document,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Upload failed");
  return { file_id: result.id };
}
const documentLink = (r) =>
  r.file_id
    ? `<a href="/api/files/${Number(r.file_id)}">Download document</a>`
    : "";
export function credentialCards(rows, manage = false, admin = false) {
  return (
    rows
      .map((r) =>
        panel(
          r.title,
          `<p>${esc(r.owner_name || r.label || "")} · ${esc(r.issuer)} · ${esc(r.number)}</p><p>${status(r.expired ? "expired" : r.status)} Expires ${esc(r.expires_on)}${r.coverage_amount ? ` · USD ${money(r.coverage_amount)} coverage` : ""}</p>${r.checked ? `<p>Checked: ${esc(r.checked)} · ${esc(dateLabel(r.reviewed_at))}</p>` : "<p>Not independently verified yet.</p>"}${r.review_note ? `<p>${esc(r.review_note)}</p>` : ""}${documentLink(r)}<div class="actions">${admin && r.status === "pending" ? button("Review credential", "trust-verify", r.id) : manage && ["pending", "verified"].includes(r.status) ? button("Withdraw credential", "trust-withdraw-credential", r.id) : ""}</div>`,
        ),
      )
      .join("") || "<p>No credentials on file.</p>"
  );
}
export function reputation(r) {
  return panel(
    "Completed-work reputation",
    r?.count
      ? `<p><strong>${esc(r.overall)} / 5</strong> · ${r.count} completed scopes · USD ${money(r.value)} contract value</p>${r.recent.map((x) => `<article class="list-row"><div><strong>${esc(x.project_title)} · ${esc(x.scope)}</strong><p>${esc(x.reviewer_name)} · ${esc(dateLabel(x.created_at))} · USD ${money(x.contract_value)}</p><p>Schedule ${x.schedule}/5 · Quality ${x.quality}/5 · Communication ${x.communication}/5 · Closeout ${x.closeout}/5</p><p>${esc(x.comment)}</p></div></article>`).join("")}`
      : "<p>No completed-work reviews yet.</p>",
  );
}
export async function renderTrust(c, route, part) {
  if (route === "trust-profile" || route === "trust-organization") {
    const p = await api(
      route === "trust-profile"
        ? `/users/${part}`
        : `/organizations/${part}/profile`,
    );
    return (
      heading(
        "Trust & verification",
        p.full_name || p.name,
        "Credentials and reviews from completed scopes",
      ) +
      credentialCards(p.credentials) +
      reputation(p.reputation)
    );
  }
  if (route === "credentials") {
    c.data.credentialOrg = Number(part) || null;
    const rows = await api("/credentials" + (part ? `?org_id=${part}` : ""));
    return (
      heading(
        "Trust & verification",
        "Credentials",
        "Add a current record for renewal. Administrators record what they checked.",
        button("Add credential", "trust-add"),
      ) +
      `<div class="actions">${link("My credentials", "credentials")}${c.memberships
        .filter((m) => c.manages(m.org_id))
        .map((m) => link(m.organization.name, `credentials/${m.org_id}`))
        .join(
          "",
        )}${c.user.platform_role === "admin" ? link("Verification queue", "trust-admin") : ""}</div>` +
      credentialCards(rows, true)
    );
  }
  if (route === "trust-admin") {
    const [rows, disputes] = await Promise.all([
      api("/admin/credentials"),
      api("/admin/disputes"),
    ]);
    return (
      heading(
        "Administration",
        "Trust review",
        "Review submitted evidence and mediate open disputes",
      ) +
      credentialCards(rows, false, true) +
      panel(
        "Disputes",
        disputes
          .map(
            (d) =>
              `<p>${link(`Dispute ${d.id}`, `dispute/${d.id}`)} · ${esc(d.scope)} · ${status(d.status)}</p>`,
          )
          .join("") || "<p>No disputes.</p>",
      )
    );
  }
  if (route === "scope-trust") {
    const [b, review, disputes] = await Promise.all([
      api(`/subdivisions/${part}/billing`),
      api(`/subdivisions/${part}/review`),
      api(`/subdivisions/${part}/disputes`),
    ]);
    c.data.trustScope = Number(part);
    return (
      heading(
        b.project.title,
        b.subdivision.scope,
        "Reviews and disputes",
        link("Scope billing", `billing/${part}`),
      ) +
      panel(
        "Review completed work",
        review.review
          ? `<p>Schedule ${review.review.schedule}/5 · Quality ${review.review.quality}/5 · Communication ${review.review.communication}/5 · Closeout ${review.review.closeout}/5</p><p>${esc(review.review.comment)}</p>`
          : review.can_review
            ? button("Rate completed work", "trust-review", part)
            : "<p>Only the paying party can review a completed scope.</p>",
      ) +
      panel(
        "Disputes",
        `<p>A hold reserves the disputed amount on this scope. Other available funds remain usable.</p>${!disputes.some((d) => d.status === "open") && b.permissions.payer !== b.permissions.contractor ? button("Open dispute", "trust-open", part) : ""}${disputes.map((d) => `<p>${link(`Dispute ${d.id}`, `dispute/${d.id}`)} · ${status(d.status)} · USD ${money(d.amount_held)} held</p>`).join("")}`,
      )
    );
  }
  if (route === "dispute") {
    const d = await api(`/disputes/${part}`);
    c.data.dispute = d;
    const r = d.dispute,
      p = d.permissions;
    return (
      heading(
        "Dispute",
        d.scope.scope,
        `USD ${r.amount_held} held · ${r.status}`,
        link("Scope trust", `scope-trust/${d.scope.id}`),
      ) +
      panel(
        "Reason",
        `<p>${esc(r.reason)}</p><div class="actions">${button("Download dated packet", "trust-packet", part)}${p.can_comment ? button("Add evidence or note", "trust-comment", part) : ""}${p.can_propose ? button("Propose split", "trust-propose", part) : ""}${p.can_withdraw ? button("Withdraw dispute", "trust-withdraw", part) : ""}${p.can_mediate ? button("Resolve as mediator", "trust-mediate", part) : ""}</div>`,
      ) +
      (r.proposed_side
        ? panel(
            "Proposed resolution",
            `<p>USD ${money(r.proposal_contractor)} to contractor · USD ${money(r.proposal_payer)} to payer</p><p>${esc(r.proposal_note)}</p>${p.can_respond ? button("Accept split", "trust-accept", part) + button("Reject split", "trust-reject", part) : ""}`,
          )
        : "") +
      (r.status === "resolved"
        ? panel(
            "Agreed resolution",
            `<p>USD ${money(r.resolved_contractor)} to contractor · USD ${money(r.resolved_payer)} to payer</p><p>${esc(r.resolution_note)} · ${esc(dateLabel(r.resolved_at))}</p><p>See scope billing for transfer and refund processing status.</p>`,
          )
        : "") +
      panel(
        "Dated record",
        d.events
          .map(
            (e) =>
              `<article><h3>${esc(e.kind)} · ${esc(e.user_name)} · ${esc(dateLabel(e.created_at))}</h3><p>${esc(e.body)}</p>${e.amount_contractor != null ? `<p>USD ${money(e.amount_contractor)} to contractor · USD ${money(e.amount_payer)} to payer</p>` : ""}${documentLink(e)}</article>`,
          )
          .join(""),
      )
    );
  }
}
export async function trustAction(c, name, id) {
  const done = async (path, body = {}, method = "POST") => {
    const r = await write(path, body, method);
    await c.reload();
    toast(
      r.warnings?.length
        ? `Resolution recorded; settlement needs attention: ${r.warnings.join("; ")}`
        : "Changes saved",
    );
  };
  if (name === "trust-add")
    return modal(
      "Add credential",
      select("Kind", "kind", kinds) +
        field("Title", "title", "text", "", 'required maxlength="160"') +
        field("Issuer", "issuer", "text", "", 'required maxlength="200"') +
        field(
          "License or policy number",
          "number",
          "text",
          "",
          'required maxlength="120"',
        ) +
        field("Jurisdiction", "jurisdiction") +
        field(
          "Coverage amount (USD)",
          "coverage_amount",
          "number",
          "",
          'min="0.01" step="0.01"',
        ) +
        field("Effective date", "effective_on", "date") +
        field("Expiry date", "expires_on", "date", "", "required") +
        fileField(),
      async (v) =>
        done("/credentials", {
          kind: v.kind,
          title: v.title,
          issuer: v.issuer,
          number: v.number,
          jurisdiction: v.jurisdiction,
          expires_on: v.expires_on,
          ...(v.effective_on ? { effective_on: v.effective_on } : {}),
          ...(v.coverage_amount
            ? { coverage_amount: Number(v.coverage_amount) }
            : {}),
          ...(c.data.credentialOrg ? { org_id: c.data.credentialOrg } : {}),
          ...(await attachment(v)),
        }),
      "Submit credential",
    );
  if (name === "trust-verify")
    return modal(
      "Review credential",
      select("Decision", "status", [
        ["verified", "Verified"],
        ["rejected", "Rejected"],
      ]) +
        textarea(
          "What was checked",
          "checked",
          "",
          'required minlength="3" maxlength="1000"',
        ) +
        textarea("Review note", "note"),
      (v) => done(`/admin/credentials/${id}`, v, "PATCH"),
      "Record verification",
    );
  if (name === "trust-withdraw-credential")
    return modal(
      "Withdraw credential",
      "<p>This record will no longer support your bids.</p>",
      () => done(`/credentials/${id}/withdraw`),
      "Withdraw credential",
    );
  if (name === "trust-requirements") {
    const s = c.data.project.subdivisions.find((s) => s.id === id);
    return modal(
      "Required credentials",
      kinds
        .map(([k, label]) =>
          select(
            label,
            k,
            [
              ["", "Not required"],
              ["yes", "Required"],
            ],
            s.required_credentials?.includes(k) ? "yes" : "",
          ),
        )
        .join(""),
      (v) =>
        done(
          `/subdivisions/${id}/requirements`,
          {
            required_credentials: kinds
              .filter(([k]) => v[k] === "yes")
              .map(([k]) => k),
          },
          "PUT",
        ),
    );
  }
  if (name === "trust-review")
    return modal(
      "Rate completed work",
      ["schedule", "quality", "communication", "closeout"]
        .map((k) =>
          select(
            k[0].toUpperCase() + k.slice(1),
            k,
            [1, 2, 3, 4, 5].map((n) => [n, `${n} / 5`]),
            5,
          ),
        )
        .join("") + textarea("Comment", "comment", "", 'maxlength="4000"'),
      (v) =>
        done(`/subdivisions/${id}/review`, {
          ...v,
          ...Object.fromEntries(
            ["schedule", "quality", "communication", "closeout"].map((k) => [
              k,
              Number(v[k]),
            ]),
          ),
        }),
      "Publish review",
    );
  if (name === "trust-open")
    return modal(
      "Open dispute",
      textarea(
        "Reason",
        "reason",
        "",
        'required minlength="10" maxlength="10000"',
      ) +
        field(
          "Amount to hold (USD; blank holds all available funds)",
          "amount_held",
          "number",
          "",
          'min="0" step="0.01"',
        ),
      async (v) => {
        const r = await write(`/subdivisions/${id}/disputes`, {
          reason: v.reason,
          ...(v.amount_held !== ""
            ? { amount_held: Number(v.amount_held) }
            : {}),
        });
        c.navigate(`dispute/${r.id}`);
      },
      "Place hold",
    );
  if (name === "trust-comment")
    return modal(
      "Add evidence or note",
      textarea("Note", "body", "", 'maxlength="10000"') + fileField(),
      async (v) =>
        done(`/disputes/${id}/comments`, {
          body: v.body,
          ...(await attachment(v)),
        }),
      "Add to record",
    );
  if (["trust-propose", "trust-mediate"].includes(name))
    return modal(
      name === "trust-mediate" ? "Resolve as mediator" : "Propose split",
      `<p>The split must total USD ${esc(c.data.dispute.dispute.amount_held)}.</p>` +
        field("To contractor (USD)", "to_contractor", "number", "0", numeric) +
        field(
          "To payer (USD)",
          "to_payer",
          "number",
          c.data.dispute.dispute.amount_held,
          numeric,
        ) +
        textarea("Resolution note", "note"),
      (v) =>
        done(
          name === "trust-mediate"
            ? `/admin/disputes/${id}/resolve`
            : `/disputes/${id}/proposals`,
          {
            ...v,
            to_contractor: Number(v.to_contractor),
            to_payer: Number(v.to_payer),
          },
        ),
      name === "trust-mediate" ? "Resolve and settle" : "Send proposal",
    );
  if (["trust-accept", "trust-reject", "trust-withdraw"].includes(name))
    return modal(
      name === "trust-accept"
        ? "Accept split and settle funds"
        : name === "trust-reject"
          ? "Reject split"
          : "Withdraw dispute",
      textarea("Decision note", "note"),
      (v) =>
        done(
          `/disputes/${id}/${name === "trust-withdraw" ? "withdraw" : "response"}`,
          {
            ...v,
            ...(name === "trust-withdraw"
              ? {}
              : { decision: name === "trust-accept" ? "accept" : "reject" }),
          },
        ),
      "Confirm",
    );
  if (name === "trust-packet") {
    const data = await api(`/disputes/${id}/packet`);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `dispute-${id}-packet.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function reputationSummary(r) {
  return `<p>${r?.count ? `${esc(r.overall)} / 5 · ${r.count} completed scopes · USD ${money(r.value)} contract value` : "No completed-work reviews yet."}</p>`;
}

export function standingSummary(s) {
  if (!s) return "";
  const labels = (values) =>
    values.map((k) => kinds.find(([key]) => key === k)?.[1] || k).join(", ");
  return `<small>${s.verified.length ? `Verified: ${esc(labels(s.verified))}. ` : ""}${s.pending.length ? `Pending verification: ${esc(labels(s.pending))}. ` : ""}${s.expired.map((x) => `${esc(x.label)} expired ${esc(x.expires_on)}. `).join("")}${s.missing.length ? `Missing required credentials: ${esc(labels(s.missing))}.` : ""}</small>`;
}
