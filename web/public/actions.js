import { trustAction } from "./trust.js";
import { billingAction } from "./billing.js";
import { fieldAction } from "./field-console.js";
import { api, all, write, uploadFile, clearTokens } from "./api.js";
import { isNative } from "./native.js";
import {
  typeFields,
  typeValues,
  esc,
  money,
  today,
  dateLabel,
  status,
  field,
  textarea,
  select,
  modal,
  confirm,
  toast,
  table,
  row,
  empty,
} from "./ui.js";
const decimal = 'required min="0" max="9999999999.99" step="0.01"';
const positive = 'required min="0.01" max="9999999999.99" step="0.01"';
const quantity = 'required min="1" max="2147483647" step="1"';
const executable = (s) => ["awarded", "active"].includes(s.status);
export async function action(c, name, id) {
  const d = c.data;
  id = Number(id) || undefined;
  if (name.startsWith("trust-")) return trustAction(c, name, id);
  if (name.startsWith("billing-")) return billingAction(c, name, id);
  if (name.startsWith("field-")) return fieldAction(c, name, id);
  const done = async (fn, message = "Changes saved") => {
    await fn();
    toast(message);
    await c.reload();
  };
  const actor = () =>
    select(
      "Act as",
      "org_id",
      [
        ["", "Myself"],
        ...c.memberships
          .filter((m) => c.manages(m.org_id))
          .map((m) => [m.org_id, m.organization.name]),
      ],
      c.org?.id || "",
    );
  const orgBody = (v) => (v.org_id ? { org_id: Number(v.org_id) } : {});
  if (name === "logout")
    return confirm(
      "Sign out?",
      "Your saved work will be here when you return.",
      async () => {
        await write("/auth/logout");
        clearTokens();
        localStorage.removeItem("workorder:field:identity");
        // The bundled app has no /login document to navigate to; dropping the
        // hash and reloading sends it back through boot() with no token, which
        // is what renders the sign-in screen.
        if (isNative()) {
          location.hash = "";
          location.reload();
        } else location.assign("/login");
      },
      "Sign out",
    );
  if (name === "profile")
    return modal(
      "Edit your profile",
      field(
        "Full name",
        "full_name",
        "text",
        c.user.full_name,
        'required maxlength="120" autocomplete="name"',
      ) +
        textarea(
          "Skills (one per line)",
          "skills",
          c.user.skills.join("\n"),
          'maxlength="4000"',
        ) +
        field(
          "Hourly rate",
          "hourly_rate",
          "number",
          c.user.hourly_rate,
          decimal,
        ) +
        select(
          "Availability",
          "availability_status",
          [
            ["available", "Available for work"],
            ["busy", "Busy"],
            ["unavailable", "Unavailable"],
          ],
          c.user.availability_status,
        ),
      (v) =>
        done(
          () =>
            write(
              "/me",
              {
                full_name: v.full_name,
                skills: v.skills
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
                hourly_rate: Number(v.hourly_rate),
                availability_status: v.availability_status,
              },
              "PATCH",
            ),
          "Profile updated",
        ),
    );
  if (name === "resume")
    return modal(
      "Add your resume",
      field(
        "Resume (PDF, JPEG, PNG or WebP)",
        "resume",
        "file",
        "",
        'required accept="application/pdf,image/jpeg,image/png,image/webp"',
      ) +
        '<p class="hint">Hiring managers can view this when you apply for a role.</p>',
      (v) =>
        done(async () => {
          const file = v.resume;
          if (!file?.size) throw new Error("Choose a file to upload.");
          const fileId = await uploadFile(file);
          await write("/me", { resume_file_id: fileId }, "PATCH");
        }, "Resume added"),
      "Upload resume",
    );
  if (name === "remove-resume")
    return confirm(
      "Remove resume",
      "Hiring managers will no longer be able to view it.",
      () =>
        done(
          () => write("/me", { resume_file_id: null }, "PATCH"),
          "Resume removed",
        ),
      "Remove resume",
    );
  if (name === "delete-account")
    return modal(
      "Delete your account",
      `<p>This cannot be undone. Your profile, skills, resume, credentials, notifications and sign-in are removed for good.</p><p>Awarded work, recorded hours, payments, lien waivers, signed documents, disputes and reviews stay on WorkOrder for the people who depend on them, with your personal details taken off them.</p>` +
        field(
          `Type ${c.user.email} to confirm`,
          "confirm_email",
          "email",
          "",
          'required autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"',
        ),
      async (v) => {
        if (
          (v.confirm_email || "").trim().toLowerCase() !==
          c.user.email.toLowerCase()
        )
          throw new Error(
            "That is not the email address on this account. Type it exactly to confirm.",
          );
        await write("/me", { confirm_email: v.confirm_email }, "DELETE");
        clearTokens();
        localStorage.removeItem("workorder:field:identity");
        if (isNative()) {
          location.hash = "";
          location.reload();
        } else location.assign("/login");
      },
      "Delete my account",
    );
  if (name === "person") {
    const u = await api(`/users/${id}`);
    return modal(
      u.full_name,
      `${status(u.availability_status)}<p>Hourly rate: <strong>${money(u.hourly_rate)}</strong></p><h3>Skills</h3><div class="tags">${u.skills.map((s) => `<span>${esc(s)}</span>`).join("") || "<p>No skills listed yet.</p>"}</div>`,
      null,
    );
  }
  if (name === "read-notification")
    return done(
      () => write(`/notifications/${id}`, {}, "PATCH"),
      "Marked as read",
    );
  if (name === "read-all")
    return done(
      () => write("/notifications/read-all", {}, "PATCH"),
      "All notifications marked as read",
    );
  const createOrganizationModal = (note) =>
    modal(
      "Create an organization",
      field(
        "Organization name",
        "name",
        "text",
        "",
        'required maxlength="160"',
      ) +
        field("Trade or focus", "trade_focus", "text", "", 'maxlength="160"') +
        typeFields() +
        `<p class="hint">${esc(note || "You’ll become the owner. Post a role to invite people to apply and join.")}</p>`,
      (v) =>
        done(
          () => write("/organizations", typeValues(v)),
          "Organization created",
        ),
      "Create organization",
    );
  if (name === "organization") return createOrganizationModal();
  if (name === "edit-organization")
    return modal(
      "Organization settings",
      field(
        "Organization name",
        "name",
        "text",
        d.organization.name,
        'required maxlength="160"',
      ) +
        field(
          "Trade or focus",
          "trade_focus",
          "text",
          d.organization.trade_focus,
          'maxlength="160"',
        ) +
        typeFields(d.organization.organization_types),
      (v) =>
        done(
          () =>
            write(
              `/organizations/${d.organization.id}`,
              typeValues(v),
              "PATCH",
            ),
          "Organization updated",
        ),
    );
  if (name === "add-child")
    return modal(
      "Add child scopes",
      textarea(
        "Scopes (one per line)",
        "scopes",
        "",
        'required maxlength="20000"',
      ) +
        '<p class="hint">Each scope accepts its own bids. Awarded contractors can delegate further. Complete child scopes before closing their parent.</p>',
      (v) =>
        done(
          () =>
            write(`/subdivisions/${id}/children`, {
              scopes: v.scopes
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            }),
          "Child scopes added",
        ),
    );
  if (name === "member-role") {
    const member = d.members.find((m) => m.user_id === id);
    return modal(
      `Change ${member.user.full_name}’s role`,
      select(
        "Role",
        "internal_role",
        [
          ["member", "Member — log time and use shared stock"],
          ["manager", "Manager — manage hiring and organization work"],
        ],
        member.internal_role,
      ),
      (v) =>
        done(
          () =>
            write(
              `/organizations/${d.organization.id}/members`,
              { user_id: id, ...v },
              "PUT",
            ),
          "Member role updated",
        ),
    );
  }
  if (name === "project")
    return modal(
      "Post a project",
      actor() +
        field(
          "Project title",
          "title",
          "text",
          "",
          'required maxlength="200"',
        ) +
        textarea("Description", "description", "", 'maxlength="10000"') +
        textarea(
          "Subdivisions (one scope per line, optional)",
          "subdivisions",
          "",
          'maxlength="20000"',
        ) +
        '<p class="hint">Leave subdivisions blank to post the project as one piece of work.</p>',
      async (v) => {
        const scopes = v.subdivisions
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const p = await write("/projects", {
          title: v.title,
          description: v.description,
          ...(scopes.length ? { subdivisions: scopes } : {}),
          ...orgBody(v),
        });
        toast("Project posted");
        c.navigate(`project/${p.id}`);
      },
      "Post project",
    );
  if (name === "subdivide")
    return modal(
      "Edit subdivisions",
      textarea(
        "Scopes (one per line)",
        "scopes",
        d.project.subdivisions.map((s) => s.scope).join("\n"),
        'required maxlength="20000"',
      ) +
        '<p class="hint">Scopes can only be replaced before any bids have been submitted.</p>',
      (v) =>
        done(
          () =>
            write(
              `/projects/${id}/subdivisions`,
              {
                scopes: v.scopes
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              },
              "PUT",
            ),
          "Subdivisions updated",
        ),
    );
  if (name === "cancel-project")
    return confirm(
      "Cancel this project?",
      "This closes the project and rejects its pending bids. This action cannot be undone.",
      () => done(() => write(`/projects/${id}/cancel`), "Project cancelled"),
      "Cancel project",
    );
  if (name === "bid") {
    const orgs = c.memberships.filter((m) => c.manages(m.org_id));
    if (!orgs.length)
      return createOrganizationModal(
        "Bids go through an organization — even solo work. This can just be you. Create one, then submit your bid again.",
      );
    return modal(
      "Submit a bid",
      select(
        "Bidding as",
        "org_id",
        orgs.map((m) => [m.org_id, m.organization.name]),
      ) + field("Bid amount", "amount", "number", "", positive),
      (v) =>
        done(
          () =>
            write(`/subdivisions/${id}/bids`, {
              amount: Number(v.amount),
              org_id: Number(v.org_id),
            }),
          "Bid submitted",
        ),
      "Submit bid",
    );
  }
  if (name === "award")
    return confirm(
      "Award this bid?",
      "This assigns the subdivision to this bidder and rejects competing bids. The award cannot be reassigned.",
      () => done(() => write(`/bids/${id}/award`), "Bid awarded"),
      "Award bid",
    );
  if (name === "withdraw-bid")
    return confirm(
      "Withdraw this bid?",
      "Your bid will no longer be available for the client to award.",
      () => done(() => write(`/bids/${id}/withdraw`), "Bid withdrawn"),
      "Withdraw bid",
    );
  if (name === "start-work")
    return done(
      () => write(`/subdivisions/${id}`, { status: "active" }, "PATCH"),
      "Work started",
    );
  if (name === "complete-work")
    return confirm(
      "Complete this subdivision?",
      "Log any remaining time and materials first. Completed work no longer accepts resource changes.",
      () =>
        done(
          () => write(`/subdivisions/${id}`, { status: "completed" }, "PATCH"),
          "Work completed",
        ),
      "Complete work",
    );
  if (name === "company-role") {
    const role = d.roles.find((r) => r.id === id);
    return modal(
      role ? "Edit company role" : "Create company role",
      field(
        "Role name",
        "name",
        "text",
        role?.name || "",
        'required maxlength="160"',
      ) +
        textarea(
          "Responsibilities",
          "description",
          role?.description || "",
          'maxlength="10000"',
        ) +
        textarea(
          "Required skills (one per line)",
          "skills",
          role?.skills.join("\n") || "",
          'maxlength="4000"',
        ) +
        field(
          "Base hourly pay",
          "hourly_rate",
          "number",
          role?.hourly_rate ?? "",
          decimal,
        ) +
        '<p class="hint">Base pay applies to members using this role’s rate. Individual agreed pay takes precedence. Changes affect new time entries only. Company roles do not grant administrative access.</p>',
      (v) =>
        done(
          () =>
            write(
              `/organizations/${d.organization.id}/roles${role ? `/${id}` : ""}`,
              {
                ...v,
                hourly_rate: Number(v.hourly_rate),
                skills: v.skills
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              },
              role ? "PATCH" : "POST",
            ),
          "Company role saved",
        ),
    );
  }
  if (name === "member-pay") {
    const member = d.members.find((m) => m.user_id === id);
    return modal(
      `Role & pay · ${member.user.full_name}`,
      select(
        "Company role",
        "company_role_id",
        [
          ["", "No company role"],
          ...d.roles.map((r) => [
            r.id,
            `${r.name} · ${money(r.hourly_rate)} / hour`,
          ]),
        ],
        member.company_role_id || "",
      ) +
        field(
          "Individual hourly pay (optional)",
          "hourly_rate",
          "number",
          member.hourly_rate ?? "",
          'min="0" max="9999999999.99" step="0.01"',
        ) +
        '<p class="hint">Leave individual pay blank to use the role’s base pay, or the worker’s profile rate if no role is assigned. An entered amount overrides the role rate. Existing time entries keep their saved rate.</p>',
      (v) =>
        done(
          () =>
            write(
              `/organizations/${d.organization.id}/pay`,
              {
                user_id: id,
                company_role_id: v.company_role_id
                  ? Number(v.company_role_id)
                  : null,
                hourly_rate:
                  v.hourly_rate === "" ? null : Number(v.hourly_rate),
              },
              "PUT",
            ),
          "Member pay updated",
        ),
    );
  }
  if (name === "job") {
    const roleSets = await Promise.all(
      c.memberships
        .filter((m) => c.manages(m.org_id))
        .map(async (m) => ({
          org: m.org_id,
          roles: await all(`/organizations/${m.org_id}/roles`),
        })),
    );
    modal(
      "Post a job",
      actor() +
        select("Company role (optional)", "company_role_id", [
          ["", "Custom position"],
        ]) +
        field("Job title", "title", "text", "", 'required maxlength="200"') +
        textarea(
          "Description",
          "description",
          "",
          'required maxlength="10000"',
        ) +
        field("Advertised hourly pay", "hourly_rate", "number", "", decimal) +
        '<p class="hint">Applicants can request a different rate. You agree on final pay before they join.</p>',
      async (v) => {
        const j = await write("/jobs", {
          title: v.title,
          description: v.description,
          hourly_rate: Number(v.hourly_rate),
          ...orgBody(v),
          ...(v.company_role_id
            ? { company_role_id: Number(v.company_role_id) }
            : {}),
        });
        toast("Job posted");
        c.navigate(`job/${j.id}`);
      },
      "Post job",
    );
    const form = document.querySelector("#modal form");
    const updateRoles = () => {
      const roles =
        roleSets.find((r) => r.org === Number(form.elements.org_id.value))
          ?.roles || [];
      form.elements.company_role_id.innerHTML =
        `<option value="">Custom position</option>` +
        roles
          .map((r) => `<option value="${r.id}">${esc(r.name)}</option>`)
          .join("");
    };
    form.elements.org_id.onchange = updateRoles;
    form.elements.company_role_id.onchange = () => {
      const role = roleSets
        .flatMap((r) => r.roles)
        .find((r) => r.id === Number(form.elements.company_role_id.value));
      if (role) {
        form.elements.title.value = role.name;
        form.elements.description.value = role.description;
        form.elements.hourly_rate.value = role.hourly_rate;
      }
    };
    updateRoles();
    return;
  }
  if (name === "apply")
    return modal(
      "Apply for this role",
      field(
        "Desired hourly pay",
        "desired_rate",
        "number",
        d.job.hourly_rate ?? c.user.hourly_rate,
        decimal,
      ) +
        textarea("Message to employer", "note", "", 'maxlength="2000"') +
        '<p class="hint">Request the advertised rate or propose your own. You will review the employer’s final offer before joining.</p>',
      (v) =>
        done(
          () =>
            write(`/jobs/${id}/applications`, {
              desired_rate: Number(v.desired_rate),
              note: v.note,
            }),
          "Application submitted",
        ),
      "Apply",
    );
  if (name === "counter-offer") {
    const app = (d.rows || d.applicants).find((a) => a.id === id);
    return modal(
      "Negotiate hourly pay",
      `<p>Employer offer: <strong>${app.offered_rate === null ? "Not yet offered" : money(app.offered_rate) + " / hour"}</strong></p>` +
        field(
          "Desired hourly pay",
          "desired_rate",
          "number",
          app.desired_rate ?? c.user.hourly_rate,
          decimal,
        ) +
        textarea("Message to employer", "note", "", 'maxlength="2000"') +
        '<p class="hint">A new request replaces any outstanding offer. The employer must send a new offer before you can accept.</p>',
      (v) =>
        done(
          () =>
            write(`/applications/${id}/counter`, {
              desired_rate: Number(v.desired_rate),
              note: v.note,
              revision: app.revision,
            }),
          "Pay request sent",
        ),
      "Send request",
    );
  }
  if (name === "pay-history") {
    const app = (d.rows || d.applicants).find((a) => a.id === id);
    return modal(
      "Pay discussion",
      app.negotiation
        .map(
          (n) =>
            `<div class="list-row"><div><strong>${esc(n.kind)} ${n.rate == null ? "" : money(n.rate) + " / hour"}</strong><small>${dateLabel(n.at)}</small><p class="preserve">${esc(n.note)}</p></div></div>`,
        )
        .join("") || "<p>No pay discussion recorded.</p>",
      null,
    );
  }
  if (name === "close-job")
    return confirm(
      "Close this posting?",
      "Pending applications and outstanding offers will be rejected. Existing accepted members will stay on your roster.",
      () => done(() => write(`/jobs/${id}/close`), "Posting closed"),
      "Close posting",
    );
  if (name === "offer") {
    const app = d.applicants.find((a) => a.id === id);
    return modal(
      "Make an employment offer",
      `<p>Requested pay: <strong>${app.desired_rate == null ? "Not specified" : money(app.desired_rate) + " / hour"}</strong></p>` +
        field(
          "Offered hourly pay",
          "offered_rate",
          "number",
          app.offered_rate ??
            app.desired_rate ??
            d.job.hourly_rate ??
            app.applicant.hourly_rate,
          decimal,
        ) +
        textarea("Message to applicant", "note", "", 'maxlength="2000"') +
        '<p class="hint">Acceptance saves this rate as the member’s individual company pay.</p>',
      (v) =>
        done(
          () =>
            write(
              `/applications/${id}`,
              {
                status: "offered",
                offered_rate: Number(v.offered_rate),
                note: v.note,
                revision: app.revision,
              },
              "PATCH",
            ),
          "Offer sent",
        ),
      "Make offer",
    );
  }
  if (name === "reject")
    return confirm(
      "Reject this application?",
      "This decision closes the application.",
      () =>
        done(
          () => write(`/applications/${id}`, { status: "rejected" }, "PATCH"),
          "Application rejected",
        ),
      "Reject application",
    );
  if (name === "accept-offer") {
    const app = (d.rows || d.applicants).find((a) => a.id === id);
    return confirm(
      "Accept this offer?",
      `Agreed hourly pay: ${app.offered_rate == null ? "not specified" : money(app.offered_rate)}. For organization roles, accepting adds you to the roster at this rate.`,
      () =>
        done(
          () => write(`/applications/${id}/accept`, { revision: app.revision }),
          "Offer accepted",
        ),
      "Accept offer",
    );
  }
  if (name === "withdraw-application")
    return confirm(
      "Withdraw your application?",
      "You will no longer be considered for this posting.",
      () =>
        done(
          () => write(`/applications/${id}/withdraw`),
          "Application withdrawn",
        ),
      "Withdraw application",
    );
  if (name === "inventory")
    return modal(
      "Add inventory",
      field("Item name", "item_name", "text", "", 'required maxlength="200"') +
        `<div class="form-grid">${field("Opening stock", "stock", "number", 0, 'required min="0" max="2147483647" step="1"')}${field("Unit", "unit", "text", "each", 'required maxlength="40"')}</div>` +
        field("Unit cost", "unit_cost", "number", 0, decimal) +
        `<p class="hint">Owned by ${esc(d.inventoryOrg ? c.memberships.find((m) => m.org_id === d.inventoryOrg)?.organization.name : c.user.full_name)}.</p>`,
      (v) =>
        done(
          () =>
            write("/inventory", {
              ...v,
              stock: Number(v.stock),
              unit_cost: Number(v.unit_cost),
              ...(d.inventoryOrg ? { org_id: d.inventoryOrg } : {}),
            }),
          "Inventory added",
        ),
      "Add item",
    );
  if (name === "receipt") {
    const item = d.items.find((i) => i.id === id);
    return modal(
      `Receive ${item.item_name}`,
      field("Quantity received", "quantity", "number", "", quantity) +
        field("Reason", "reason", "text", "", 'required maxlength="500"') +
        field("New unit cost", "unit_cost", "number", item.unit_cost, decimal) +
        '<p class="hint">New cost applies to future consumption. Previously recorded costs stay the same.</p>',
      (v) =>
        done(
          () =>
            write(`/inventory/${id}/receipts`, {
              ...v,
              quantity: Number(v.quantity),
              unit_cost: Number(v.unit_cost),
            }),
          "Stock received",
        ),
      "Receive stock",
    );
  }
  if (name === "ledger") {
    const movements = await all(`/inventory/${id}/movements`);
    return modal(
      "Stock history",
      movements.length
        ? table(
            ["Date", "Change", "Reason"],
            movements.map((m) =>
              row([
                dateLabel(m.created_at),
                `${m.quantity > 0 ? "+" : ""}${m.quantity}`,
                esc(m.reason),
              ]),
            ),
          )
        : empty("No movements yet", "Receipts and usage will appear here."),
      null,
    );
  }
  if (name === "consume" || name === "consume-item") {
    let assignments = (await all("/me/assignments")).filter(executable);
    let items;
    if (name === "consume") {
      const assignment = assignments.find((s) => s.id === id);
      if (!assignment)
        throw new Error(
          "This work is no longer available to you. Refresh and try again.",
        );
      assignments = [assignment];
      items = await all("/inventory");
      if (assignment.awarded_org_id)
        items.push(
          ...(await all(
            `/organizations/${assignment.awarded_org_id}/inventory`,
          )),
        );
    } else {
      const item = d.items.find((i) => i.id === id);
      items = [item];
      if (item.owner_org_id)
        assignments = assignments.filter(
          (s) => s.awarded_org_id === item.owner_org_id,
        );
    }
    items = items.filter((i) => i.stock > 0);
    if (!assignments.length || !items.length)
      return modal(
        "Use materials",
        empty(
          "No available materials or work",
          "You need stock on hand and an executable assignment belonging to the same owner.",
        ),
        null,
      );
    return modal(
      "Use materials on a project",
      select(
        "Assignment",
        "subdivision_id",
        assignments.map((s) => [s.id, `${s.project.title} · ${s.scope}`]),
      ) +
        select(
          "Inventory item",
          "item_id",
          items.map((i) => [
            i.id,
            `${i.item_name} — ${i.stock} ${i.unit} (${i.owner_org_id ? "organization" : "personal"})`,
          ]),
        ) +
        field("Quantity to use", "qty", "number", "", quantity),
      (v) =>
        done(
          () =>
            write(`/subdivisions/${v.subdivision_id}/materials`, {
              item_id: Number(v.item_id),
              qty: Number(v.qty),
            }),
          "Materials recorded",
        ),
      "Record usage",
    );
  }
  if (name === "log-time") {
    c.timeAssignment = id;
    if (location.hash.split("?")[0].startsWith("#time")) {
      const form = document.querySelector("#time-entry-form");
      form?.scrollIntoView({ behavior: "smooth", block: "start" });
      form?.querySelector("select")?.focus();
    } else c.navigate("time/personal");
    return;
  }
  if (name === "edit-time") {
    const entry = d.entries.find((e) => e.id === id);
    return modal(
      "Edit time entry",
      `<p>Saved hourly rate: <strong>${money(entry.hourly_rate)}</strong></p><div class="form-grid">${field("Date worked", "date", "date", entry.date, "required")}${entry.start_time ? field("Start time", "start_time", "time", entry.start_time.slice(0, 5), "required") + field("End time", "end_time", "time", entry.end_time.startsWith("24:") ? "00:00" : entry.end_time.slice(0, 5), "required") : field("Hours", "hours", "number", entry.hours, 'required min="0.01" max="24" step="0.01"') + field("Start time (optional)", "start_time", "time", "") + field("End time (optional)", "end_time", "time", "")}</div>` +
        (!entry.start_time
          ? '<p class="hint">Add both clock times to place this entry on the grid. Hours will be calculated from those times.</p>'
          : "") +
        textarea("Note", "note", entry.note, 'maxlength="2000"'),
      (v) =>
        done(
          () =>
            write(
              `/time/${id}`,
              {
                date: v.date,
                note: v.note,
                ...(v.start_time || v.end_time
                  ? {
                      start_time: v.start_time || null,
                      end_time: v.end_time || null,
                    }
                  : { hours: Number(v.hours) }),
              },
              "PATCH",
            ),
          "Time updated",
        ),
    );
  }
  if (name === "delete-time")
    return confirm(
      "Delete this time entry?",
      "It will be removed from your personal and organization totals.",
      () =>
        done(
          () => write(`/time/${id}`, undefined, "DELETE"),
          "Time entry deleted",
        ),
      "Delete entry",
    );
  if (name === "retry") return c.reload();
}
