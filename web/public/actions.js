import { api, all, write } from "./api.js";
import {
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
        location.assign("/login");
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
  if (name === "person") {
    const u = await api(`/users/${id}`);
    return modal(
      u.full_name,
      `${status(u.availability_status)}<p>Hourly rate: <strong>${money(u.hourly_rate)}</strong></p><h3>Skills</h3><div class="tags">${u.skills.map((s) => `<span>${esc(s)}</span>`).join("") || "<p>No skills listed yet.</p>"}</div>`,
      null,
    );
  }
  if (name === "organization")
    return modal(
      "Create an organization",
      field(
        "Organization name",
        "name",
        "text",
        "",
        'required maxlength="160"',
      ) +
        field("Trade or focus", "trade_focus", "text", "", 'maxlength="160"') +
        '<p class="hint">You’ll become the owner. Post a role to invite people to apply and join.</p>',
      (v) => done(() => write("/organizations", v), "Organization created"),
      "Create organization",
    );
  if (name === "switch-org") {
    await write("/context", { mode: "organization", org_id: id }, "PUT");
    c.navigate("overview");
    return;
  }
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
      field("Project title", "title", "text", "", 'required maxlength="200"') +
        textarea("Description", "description", "", 'maxlength="10000"') +
        textarea(
          "Subdivisions (one scope per line, optional)",
          "subdivisions",
          "",
          'maxlength="20000"',
        ) +
        '<p class="hint">Leave subdivisions blank to post the project as one piece of work. You’ll post as the client from your personal account.</p>',
      async (v) => {
        const scopes = v.subdivisions
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const p = await write("/projects", {
          title: v.title,
          description: v.description,
          ...(scopes.length ? { subdivisions: scopes } : {}),
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
  if (name === "bid")
    return modal(
      "Submit a bid",
      actor() + field("Bid amount", "amount", "number", "", positive),
      (v) =>
        done(
          () =>
            write(`/subdivisions/${id}/bids`, {
              amount: Number(v.amount),
              ...orgBody(v),
            }),
          "Bid submitted",
        ),
      "Submit bid",
    );
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
  if (name === "job")
    return modal(
      "Post a job",
      actor() +
        field("Job title", "title", "text", "", 'required maxlength="200"') +
        textarea(
          "Description",
          "description",
          "",
          'required maxlength="10000"',
        ),
      async (v) => {
        const j = await write("/jobs", {
          title: v.title,
          description: v.description,
          ...orgBody(v),
        });
        toast("Job posted");
        c.navigate(`job/${j.id}`);
      },
      "Post job",
    );
  if (name === "apply")
    return confirm(
      "Apply for this role?",
      "Your profile and skills will be shared with the employer. Review and accept an offer before joining.",
      () =>
        done(() => write(`/jobs/${id}/applications`), "Application submitted"),
      "Apply",
    );
  if (name === "close-job")
    return confirm(
      "Close this posting?",
      "Pending applications and outstanding offers will be rejected. Existing accepted members will stay on your roster.",
      () => done(() => write(`/jobs/${id}/close`), "Posting closed"),
      "Close posting",
    );
  if (name === "offer")
    return confirm(
      "Make an employment offer?",
      "The applicant will be able to accept the offer. Organization membership starts after acceptance.",
      () =>
        done(
          () => write(`/applications/${id}`, { status: "offered" }, "PATCH"),
          "Offer sent",
        ),
      "Make offer",
    );
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
  if (name === "accept-offer")
    return confirm(
      "Accept this offer?",
      "For an organization role, accepting adds you to its member roster.",
      () => done(() => write(`/applications/${id}/accept`), "Offer accepted"),
      "Accept offer",
    );
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
    const assignments = (await all("/me/assignments")).filter(executable);
    if (!assignments.length)
      return modal(
        "Log time",
        empty(
          "You need an active assignment",
          "Win a project bid, or join an organization with awarded work, to start logging time.",
        ),
        null,
      );
    return modal(
      "Log time",
      select(
        "Assignment",
        "subdivision_id",
        assignments.map((s) => [
          s.id,
          `${s.project.title} · ${s.scope} (${s.awardedOrganization?.name || "independent"})`,
        ]),
        id || assignments[0].id,
      ) +
        `<div class="form-grid">${field("Date worked", "date", "date", today(), "required")}${field("Hours", "hours", "number", "", 'required min="0.01" max="24" step="0.01"')}</div>` +
        textarea("Note (optional)", "note", "", 'maxlength="2000"') +
        '<p class="hint">Organization work also appears in your team’s timesheet. Your current hourly rate is saved with this entry.</p>',
      (v) =>
        done(
          () =>
            write("/time", {
              ...v,
              subdivision_id: Number(v.subdivision_id),
              hours: Number(v.hours),
            }),
          "Time logged",
        ),
      "Log time",
    );
  }
  if (name === "edit-time") {
    const entry = d.entries.find((e) => e.id === id);
    return modal(
      "Edit time entry",
      `<div class="form-grid">${field("Date worked", "date", "date", entry.date, "required")}${field("Hours", "hours", "number", entry.hours, 'required min="0.01" max="24" step="0.01"')}</div>` +
        textarea("Note", "note", entry.note, 'maxlength="2000"'),
      (v) =>
        done(
          () => write(`/time/${id}`, { ...v, hours: Number(v.hours) }, "PATCH"),
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
