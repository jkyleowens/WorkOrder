const { Op } = require("sequelize");
const bcrypt = require("bcryptjs");
const { schemas, check } = require("./validation.cjs");
const publicUser = (user) => {
  const { password_hash, ...value } = user.get({ plain: true });
  return value;
};
class PlatformService {
  constructor({ db, models }) {
    this.db = db;
    this.m = models;
  }
  async get(name, id, transaction, lock = false) {
    const row = await this.m[name].findByPk(id, {
      transaction,
      ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    check(row, 404, `${name} not found`);
    return row;
  }
  async member(user, org, transaction, manage = false) {
    const row = await this.m.OrganizationMember.findOne({
      where: { user_id: user, org_id: org },
      transaction,
      ...(transaction ? { lock: transaction.LOCK.SHARE } : {}),
    });
    check(
      row && (!manage || row.canManage()),
      403,
      "Organization permission required",
    );
    return row;
  }
  async register(input) {
    const d = schemas.register.parse(input);
    const user = await this.m.User.create({
      full_name: d.full_name,
      email: d.email,
      password_hash: await bcrypt.hash(d.password, 12),
      skills: [],
      hourly_rate: 0,
      availability_status: "available",
    });
    return publicUser(user);
  }
  async login(input) {
    const d = schemas.login.parse(input);
    const user = await this.m.User.findOne({ where: { email: d.email } });
    const valid = await bcrypt.compare(
      d.password,
      user?.password_hash ||
        "$2b$12$C6UzMDM.H6dfI/f/IKcEe.uuJ86jO4aWDlWtMqGtJiB96vffhXjie",
    );
    check(user && valid, 401, "Invalid email or password");
    return publicUser(user);
  }
  async profile(user, input) {
    const row = await this.get("User", user);
    await row.update(schemas.profile.parse(input));
    return publicUser(row);
  }
  async switchContext(user, input) {
    const d = schemas.context.parse(input);
    if (d.org_id) await this.member(user, d.org_id, null, true);
    return d;
  }
  async createOrg(user, input) {
    const d = schemas.organization.parse(input);
    return this.db.transaction(async (t) => {
      const org = await this.m.Organization.create(
        { ...d, created_by_user_id: user },
        { transaction: t },
      );
      await this.m.OrganizationMember.create(
        { user_id: user, org_id: org.id, internal_role: "owner" },
        { transaction: t },
      );
      return org;
    });
  }
  async editOrg(user, id, input) {
    const data = schemas.organization.parse(input);
    return this.db.transaction(async (t) => {
      const org = await this.get("Organization", id, t, true);
      await this.member(user, id, t, true);
      return org.update(data, { transaction: t });
    });
  }
  async canCommission(user, p, s, t) {
    if (p.client_user_id === user) return;
    check(
      s.parent_subdivision_id,
      403,
      "Only the client can commission root work",
    );
    const parent = await this.get(
      "ProjectSubdivision",
      s.parent_subdivision_id,
      t,
    );
    await this.performer(user, parent, t, true);
  }
  async addChild(user, id, input) {
    const { scopes } = schemas.subdivision.parse(input);
    return this.db.transaction(async (t) => {
      const { p, s } = await this.work(id, t);
      check(["open", "active"].includes(p.status));
      check(["open", "awarded", "active"].includes(s.status));
      if (p.client_user_id !== user) await this.performer(user, s, t, true);
      const sequence = await this.m.ProjectSubdivision.max("sequence", {
        where: { project_id: p.id },
        transaction: t,
      });
      return this.m.ProjectSubdivision.bulkCreate(
        scopes.map((scope, i) => ({
          project_id: p.id,
          parent_subdivision_id: s.id,
          scope,
          sequence: sequence + i + 1,
          status: "open",
        })),
        { transaction: t },
      );
    });
  }
  async setMember(user, org, input) {
    const d = schemas.member.parse(input);
    return this.db.transaction(async (t) => {
      await this.get("Organization", org, t, true);
      const actor = await this.member(user, org, t, true);
      check(
        actor.internal_role === "owner",
        403,
        "Only the owner can change roster roles",
      );
      const existing = await this.m.OrganizationMember.findOne({
        where: { user_id: d.user_id, org_id: org },
        transaction: t,
      });
      check(
        existing,
        404,
        "Accept an employment offer before changing a member role",
      );
      check(
        existing.internal_role !== "owner",
        403,
        "Owner role cannot be changed",
      );
      return existing.update(
        { internal_role: d.internal_role },
        { transaction: t },
      );
    });
  }
  async saveCompanyRole(user, org, id, input) {
    const d = schemas.companyRole.parse(input);
    return this.db.transaction(async (t) => {
      await this.member(user, org, t, true);
      if (!id)
        return this.m.OrganizationRole.create(
          { ...d, org_id: org },
          { transaction: t },
        );
      const role = await this.get("OrganizationRole", id, t, true);
      check(role.org_id === org, 403, "Role belongs to another organization");
      return role.update(d, { transaction: t });
    });
  }
  async setMemberPay(user, org, input) {
    const d = schemas.memberPay.parse(input);
    return this.db.transaction(async (t) => {
      await this.get("Organization", org, t, true);
      await this.member(user, org, t, true);
      if (d.company_role_id) {
        const role = await this.get("OrganizationRole", d.company_role_id, t);
        check(role.org_id === org, 403, "Role belongs to another organization");
      }
      const member = await this.member(d.user_id, org, t);
      return member.update(
        { company_role_id: d.company_role_id, hourly_rate: d.hourly_rate },
        { transaction: t },
      );
    });
  }
  async effectiveRate(user, org, t) {
    if (org) {
      const member = await this.member(user.id, org, t);
      if (member.hourly_rate !== null) return member.hourly_rate;
      if (member.company_role_id) {
        const role = await this.get(
          "OrganizationRole",
          member.company_role_id,
          t,
        );
        return role.hourly_rate;
      }
    }
    return user.hourly_rate;
  }
  negotiationEvent(user, kind, rate, note = "") {
    return { user_id: user, kind, rate, note, at: new Date().toISOString() };
  }
  async counterOffer(user, id, input) {
    const d = schemas.counter.parse(input);
    return this.db.transaction(async (t) => {
      const initial = await this.get("JobApplication", id, t);
      const job = await this.get("JobPosting", initial.job_posting_id, t, true);
      const app = await this.get("JobApplication", id, t, true);
      check(
        app.applicant_user_id === user,
        403,
        "Only the applicant can negotiate",
      );
      check(
        job.status === "open" && ["pending", "offered"].includes(app.status),
      );
      check(
        app.revision === d.revision,
        409,
        "Offer changed. Refresh before responding.",
      );
      return app.update(
        {
          desired_rate: d.desired_rate,
          offered_rate: null,
          status: "pending",
          revision: app.revision + 1,
          negotiation: [
            ...app.negotiation,
            this.negotiationEvent(user, "requested", d.desired_rate, d.note),
          ],
        },
        { transaction: t },
      );
    });
  }
  async postJob(user, input) {
    const { org_id, ...d } = schemas.job.parse(input);
    return this.db.transaction(async (t) => {
      if (org_id) await this.member(user, org_id, t, true);
      if (d.company_role_id) {
        const role = await this.get("OrganizationRole", d.company_role_id, t);
        check(
          role.org_id === org_id,
          403,
          "Role belongs to another organization",
        );
        if (d.hourly_rate === undefined)
          d.hourly_rate = Number(role.hourly_rate);
      }
      return this.m.JobPosting.create(
        {
          ...d,
          posted_by_user_id: user,
          posted_by_org_id: org_id || null,
          status: "open",
        },
        { transaction: t },
      );
    });
  }
  async manageJob(user, job, t) {
    if (job.posted_by_org_id)
      await this.member(user, job.posted_by_org_id, t, true);
    else
      check(
        job.posted_by_user_id === user,
        403,
        "Only the poster can manage this job",
      );
  }
  async closeJob(user, id) {
    return this.db.transaction(async (t) => {
      const job = await this.get("JobPosting", id, t, true);
      await this.manageJob(user, job, t);
      await this.m.JobApplication.update(
        { status: "rejected" },
        {
          where: {
            job_posting_id: id,
            status: { [Op.in]: ["pending", "offered"] },
          },
          transaction: t,
        },
      );
      return job.update({ status: "closed" }, { transaction: t });
    });
  }
  async apply(user, id, input = {}) {
    const d = schemas.application.parse(input);
    return this.db.transaction(async (t) => {
      const job = await this.get("JobPosting", id, t, true);
      check(job.status === "open");
      check(
        job.posted_by_user_id !== user,
        403,
        "Cannot apply to your own job",
      );
      if (job.posted_by_org_id)
        check(
          !(await this.m.OrganizationMember.findOne({
            where: { org_id: job.posted_by_org_id, user_id: user },
            transaction: t,
          })),
          409,
          "Already a member",
        );
      return this.m.JobApplication.create(
        {
          job_posting_id: id,
          applicant_user_id: user,
          status: "pending",
          desired_rate: d.desired_rate ?? job.hourly_rate,
          revision: 0,
          negotiation: [
            this.negotiationEvent(
              user,
              "requested",
              d.desired_rate ?? job.hourly_rate,
              d.note,
            ),
          ],
        },
        { transaction: t },
      );
    });
  }
  async applicationAction(user, id, action, input = {}) {
    const d = ["offered", "rejected"].includes(action)
      ? schemas.decision.parse({ ...input, status: action })
      : schemas.acceptance.parse(input);
    return this.db.transaction(async (t) => {
      const initial = await this.get("JobApplication", id, t);
      const job = await this.get("JobPosting", initial.job_posting_id, t, true);
      const app = await this.get("JobApplication", id, t, true);
      if (["offered", "rejected"].includes(action)) {
        await this.manageJob(user, job, t);
        check(
          job.status === "open" && ["pending", "offered"].includes(app.status),
        );
      } else {
        check(
          app.applicant_user_id === user,
          403,
          "Only the applicant can respond",
        );
        check(
          action === "accepted"
            ? app.status === "offered" && job.status === "open"
            : ["pending", "offered"].includes(app.status),
        );
      }
      if (d.revision !== undefined)
        check(
          d.revision === app.revision,
          409,
          "Offer changed. Refresh before responding.",
        );
      // Rated offers must be accepted explicitly at the version the applicant reviewed.
      if (action === "accepted" && app.offered_rate !== null)
        check(
          d.revision !== undefined,
          409,
          "Review the current pay offer before accepting.",
        );
      const offered =
        action === "offered"
          ? (d.offered_rate ?? app.desired_rate ?? job.hourly_rate)
          : app.offered_rate;
      if (action === "accepted" && job.posted_by_org_id) {
        const [, created] = await this.m.OrganizationMember.findOrCreate({
          where: { user_id: user, org_id: job.posted_by_org_id },
          defaults: {
            internal_role: "member",
            company_role_id: job.company_role_id,
            hourly_rate: offered,
          },
          transaction: t,
        });
        check(
          created,
          409,
          "Already a member. Ask an administrator to update your company pay.",
        );
      }
      return app.update(
        {
          status: action,
          offered_rate: offered,
          revision: app.revision + 1,
          negotiation: [
            ...app.negotiation,
            this.negotiationEvent(user, action, offered, d.note),
          ],
        },
        { transaction: t },
      );
    });
  }
  async postProject(user, input) {
    const { subdivisions, ...d } = schemas.project.parse(input);
    return this.db.transaction(async (t) => {
      const p = await this.m.Project.create(
        { ...d, client_user_id: user, status: "open" },
        { transaction: t },
      );
      await this.m.ProjectSubdivision.bulkCreate(
        (subdivisions || [d.description || d.title]).map((scope, i) => ({
          project_id: p.id,
          scope,
          sequence: i + 1,
          status: "open",
        })),
        { transaction: t },
      );
      return this.projectDetail(p.id, t);
    });
  }
  async projectDetail(id, t) {
    const project = await this.get("Project", id, t);
    return {
      ...project.get({ plain: true }),
      subdivisions: await this.m.ProjectSubdivision.findAll({
        where: { project_id: id },
        include: [
          {
            model: this.m.User,
            as: "awardedUser",
            attributes: ["id", "full_name"],
          },
          { model: this.m.Organization, as: "awardedOrganization" },
        ],
        order: [["sequence", "ASC"]],
        transaction: t,
      }),
    };
  }
  async subdivide(user, id, input) {
    const { scopes } = schemas.subdivision.parse(input);
    return this.db.transaction(async (t) => {
      const p = await this.get("Project", id, t, true);
      check(p.client_user_id === user, 403, "Only the client can subdivide");
      check(p.status === "open");
      const subs = await this.m.ProjectSubdivision.findAll({
        where: { project_id: id },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      check(subs.every((s) => s.status === "open"));
      check(
        !(await this.m.Bid.count({
          where: { subdivision_id: { [Op.in]: subs.map((s) => s.id) } },
          transaction: t,
        })),
        409,
        "Cannot replace subdivisions after bids",
      );
      await this.m.ProjectSubdivision.destroy({
        where: { project_id: id },
        transaction: t,
      });
      await this.m.ProjectSubdivision.bulkCreate(
        scopes.map((scope, i) => ({
          project_id: id,
          scope,
          sequence: i + 1,
          status: "open",
        })),
        { transaction: t },
      );
      return this.projectDetail(id, t);
    });
  }
  // Always lock the project before a subdivision: all award/execution paths use this order.
  async work(id, t) {
    const first = await this.get("ProjectSubdivision", id, t);
    const p = await this.get("Project", first.project_id, t, true);
    const s = await this.get("ProjectSubdivision", id, t, true);
    return { p, s };
  }
  async submitBid(user, id, input) {
    const { org_id, amount } = schemas.bid.parse(input);
    return this.db.transaction(async (t) => {
      const { p, s } = await this.work(id, t);
      check(p.client_user_id !== user, 403, "Cannot bid on your own project");
      check(p.status !== "cancelled" && s.status === "open");
      if (s.parent_subdivision_id) {
        const parent = await this.get(
          "ProjectSubdivision",
          s.parent_subdivision_id,
          t,
        );
        check(["open", "awarded", "active"].includes(parent.status));
        check(
          parent.awarded_user_id !== user &&
            (!org_id || parent.awarded_org_id !== org_id),
          403,
          "Cannot bid on work you are subcontracting",
        );
        if (parent.awarded_org_id) {
          const membership = await this.m.OrganizationMember.findOne({
            where: { user_id: user, org_id: parent.awarded_org_id },
            transaction: t,
          });
          check(!membership?.canManage(), 403, "Cannot bid on work you manage");
        }
      }
      if (org_id) {
        await this.member(user, org_id, t, true);
        check(
          !(await this.m.OrganizationMember.findOne({
            where: { user_id: p.client_user_id, org_id },
            transaction: t,
          })),
          403,
          "Client organization cannot bid",
        );
      }
      return this.m.Bid.create(
        {
          subdivision_id: id,
          bidding_user_id: org_id ? null : user,
          bidding_org_id: org_id || null,
          amount,
          status: "pending",
        },
        { transaction: t },
      );
    });
  }
  async withdrawBid(user, id) {
    return this.db.transaction(async (t) => {
      const initial = await this.get("Bid", id, t);
      await this.work(initial.subdivision_id, t);
      const b = await this.get("Bid", id, t, true);
      if (b.bidding_org_id) await this.member(user, b.bidding_org_id, t, true);
      else
        check(b.bidding_user_id === user, 403, "Only the bidder can withdraw");
      check(b.status === "pending");
      return b.update({ status: "withdrawn" }, { transaction: t });
    });
  }
  async award(user, id) {
    return this.db.transaction(async (t) => {
      const initial = await this.get("Bid", id, t);
      const { p, s } = await this.work(initial.subdivision_id, t);
      await this.canCommission(user, p, s, t);
      const b = await this.get("Bid", id, t, true);
      check(s.status === "open" && b.status === "pending");
      await this.m.Bid.update(
        { status: "rejected" },
        { where: { subdivision_id: s.id, status: "pending" }, transaction: t },
      );
      await b.update({ status: "accepted" }, { transaction: t });
      await s.update(
        {
          awarded_user_id: b.bidding_user_id,
          awarded_org_id: b.bidding_org_id,
          status: "awarded",
        },
        { transaction: t },
      );
      await p.update({ status: "active" }, { transaction: t });
      return s;
    });
  }
  async performer(user, s, t, manage = false) {
    if (s.awarded_org_id) await this.member(user, s.awarded_org_id, t, manage);
    else
      check(
        s.awarded_user_id === user,
        403,
        "Only awarded workers can record resources",
      );
    check(
      ["awarded", "active"].includes(s.status),
      409,
      "Subdivision is not active",
    );
  }
  async subdivisionStatus(user, id, input) {
    const { status } = schemas.subdivisionStatus.parse(input);
    return this.db.transaction(async (t) => {
      const { p, s } = await this.work(id, t);
      if (p.client_user_id !== user) await this.performer(user, s, t, true);
      check(
        status === "active"
          ? s.status === "awarded"
          : ["awarded", "active"].includes(s.status),
      );
      if (status === "completed")
        check(
          !(await this.m.ProjectSubdivision.count({
            where: {
              parent_subdivision_id: s.id,
              status: { [Op.ne]: "completed" },
            },
            transaction: t,
          })),
          409,
          "Complete all child work before completing this scope",
        );
      await s.update({ status }, { transaction: t });
      if (
        !(await this.m.ProjectSubdivision.count({
          where: { project_id: p.id, status: { [Op.ne]: "completed" } },
          transaction: t,
        }))
      )
        await p.update({ status: "completed" }, { transaction: t });
      return s;
    });
  }
  async cancelProject(user, id) {
    return this.db.transaction(async (t) => {
      const p = await this.get("Project", id, t, true);
      check(p.client_user_id === user, 403, "Only the client can cancel");
      check(
        p.status === "open",
        409,
        "Only unawarded projects can be cancelled",
      );
      await this.m.ProjectSubdivision.update(
        { status: "cancelled" },
        { where: { project_id: id }, transaction: t },
      );
      const subs = await this.m.ProjectSubdivision.findAll({
        where: { project_id: id },
        transaction: t,
      });
      await this.m.Bid.update(
        { status: "rejected" },
        {
          where: {
            subdivision_id: { [Op.in]: subs.map((s) => s.id) },
            status: "pending",
          },
          transaction: t,
        },
      );
      return p.update({ status: "cancelled" }, { transaction: t });
    });
  }
  async addItem(user, input) {
    const { org_id, ...d } = schemas.inventory.parse(input);
    return this.db.transaction(async (t) => {
      if (org_id) await this.member(user, org_id, t, true);
      const item = await this.m.InventoryItem.create(
        {
          ...d,
          owner_user_id: org_id ? null : user,
          owner_org_id: org_id || null,
        },
        { transaction: t },
      );
      if (d.stock)
        await this.m.InventoryMovement.create(
          {
            item_id: item.id,
            actor_user_id: user,
            quantity: d.stock,
            reason: "Opening stock",
          },
          { transaction: t },
        );
      return item;
    });
  }
  async itemOwner(user, item, t) {
    if (item.owner_org_id) await this.member(user, item.owner_org_id, t, true);
    else
      check(
        item.owner_user_id === user,
        403,
        "Inventory owner permission required",
      );
  }
  async receive(user, id, input) {
    const d = schemas.receipt.parse(input);
    return this.db.transaction(async (t) => {
      const item = await this.get("InventoryItem", id, t, true);
      await this.itemOwner(user, item, t);
      check(
        item.stock + d.quantity <= 2147483647,
        422,
        "Stock exceeds maximum",
      );
      await item.update(
        {
          stock: item.stock + d.quantity,
          ...(d.unit_cost === undefined ? {} : { unit_cost: d.unit_cost }),
        },
        { transaction: t },
      );
      await this.m.InventoryMovement.create(
        {
          item_id: id,
          actor_user_id: user,
          quantity: d.quantity,
          reason: d.reason,
        },
        { transaction: t },
      );
      return item;
    });
  }
  async consume(user, id, input) {
    const d = schemas.consume.parse(input);
    return this.db.transaction(async (t) => {
      const { s } = await this.work(id, t);
      await this.performer(user, s, t);
      const item = await this.get("InventoryItem", d.item_id, t, true);
      if (item.owner_org_id) {
        check(
          item.owner_org_id === s.awarded_org_id,
          403,
          "Inventory belongs to another organization",
        );
        await this.member(user, item.owner_org_id, t);
      } else
        check(
          item.owner_user_id === user,
          403,
          "Inventory belongs to another user",
        );
      check(item.stock >= d.qty, 409, "Insufficient stock");
      await item.update({ stock: item.stock - d.qty }, { transaction: t });
      const use = await this.m.ProjectInventory.create(
        {
          subdivision_id: id,
          item_id: item.id,
          qty: d.qty,
          unit_cost: item.unit_cost,
        },
        { transaction: t },
      );
      await this.m.InventoryMovement.create(
        {
          item_id: item.id,
          actor_user_id: user,
          quantity: -d.qty,
          reason: "Project consumption",
          project_inventory_id: use.id,
        },
        { transaction: t },
      );
      return use;
    });
  }
  async logTime(user, input) {
    const d = schemas.time.parse(input);
    return this.db.transaction(async (t) => {
      const { s } = await this.work(d.subdivision_id, t);
      await this.performer(user, s, t);
      check(
        d.org_id === undefined || d.org_id === s.awarded_org_id,
        403,
        "Organization does not match awarded work",
      );
      const u = await this.get("User", user, t, true);
      const total =
        (await this.m.Timesheet.sum("hours", {
          where: { user_id: user, date: d.date },
          transaction: t,
        })) || 0;
      check(Number(total) + d.hours <= 24, 409, "Daily time exceeds 24 hours");
      return this.m.Timesheet.create(
        {
          ...d,
          user_id: user,
          org_id: s.awarded_org_id || null,
          hourly_rate: await this.effectiveRate(u, s.awarded_org_id, t),
        },
        { transaction: t },
      );
    });
  }
  async timeEntries(user, input) {
    const range = schemas.range.parse(input);
    return this.m.Timesheet.findAll({
      where: { user_id: user, date: { [Op.between]: [range.from, range.to] } },
      order: [
        ["date", "ASC"],
        ["id", "ASC"],
      ],
    });
  }
  async editTime(user, id, input) {
    const d = schemas.timeEdit.parse(input);
    return this.db.transaction(async (t) => {
      const first = await this.get("Timesheet", id, t);
      const { s } = await this.work(first.subdivision_id, t);
      check(first.user_id === user, 403, "Only the author can edit time");
      await this.performer(user, s, t);
      await this.get("User", user, t, true);
      const row = await this.get("Timesheet", id, t, true);
      const total =
        (await this.m.Timesheet.sum("hours", {
          where: {
            user_id: user,
            date: d.date || row.date,
            id: { [Op.ne]: id },
          },
          transaction: t,
        })) || 0;
      check(
        Number(total) + Number(d.hours ?? row.hours) <= 24,
        409,
        "Daily time exceeds 24 hours",
      );
      return row.update(d, { transaction: t });
    });
  }
  async deleteTime(user, id) {
    return this.db.transaction(async (t) => {
      const first = await this.get("Timesheet", id, t);
      const { s } = await this.work(first.subdivision_id, t);
      check(first.user_id === user, 403, "Only the author can delete time");
      await this.performer(user, s, t);
      await this.get("User", user, t, true);
      await first.destroy({ transaction: t });
      return { deleted: true };
    });
  }
  async timeReport(user, input, org, transaction) {
    if (!transaction)
      return this.db.transaction({ isolationLevel: "REPEATABLE READ" }, (t) =>
        this.timeReport(user, input, org, t),
      );
    const range = schemas.range.parse(input);
    if (org) await this.member(user, org, transaction, true);
    const where = org ? "org_id" : "user_id";
    const bind = { actor: org || user, from: range.from, to: range.to };
    const [totals] = await this.db.query(
      `SELECT COALESCE(sum(hours),0)::text AS hours, COALESCE(sum(round(hours*hourly_rate,2)),0)::text AS labor_cost FROM timesheets WHERE ${where}=$actor AND date BETWEEN $from AND $to`,
      { bind, transaction },
    );
    const [groups] = await this.db.query(
      `SELECT subdivision_id,user_id,date,hourly_rate::text AS hourly_rate,sum(hours)::text AS hours,sum(round(hours*hourly_rate,2))::text AS labor_cost FROM timesheets WHERE ${where}=$actor AND date BETWEEN $from AND $to GROUP BY subdivision_id,user_id,date,hourly_rate ORDER BY date,subdivision_id,user_id`,
      { bind, transaction },
    );
    return { ...range, ...totals[0], entries: groups };
  }
  async costs(user, id) {
    const s = await this.get("ProjectSubdivision", id);
    const p = await this.get("Project", s.project_id);
    if (p.client_user_id !== user) {
      if (s.awarded_org_id)
        await this.member(user, s.awarded_org_id, null, true);
      else check(s.awarded_user_id === user, 403, "Cost access denied");
    }
    const [rows] = await this.db.query(
      "SELECT (SELECT COALESCE(sum(round(hours*hourly_rate,2)),0)::text FROM timesheets WHERE subdivision_id=$1) AS labor_cost, (SELECT COALESCE(sum(qty*unit_cost),0)::text FROM project_inventory WHERE subdivision_id=$1) AS material_cost",
      { bind: [id] },
    );
    const [labor] = await this.db.query(
      "SELECT t.user_id,u.full_name,t.hourly_rate::text AS hourly_rate,sum(t.hours)::text AS hours,sum(round(t.hours*t.hourly_rate,2))::text AS labor_cost FROM timesheets t JOIN users u ON u.id=t.user_id WHERE subdivision_id=$1 GROUP BY t.user_id,u.full_name,t.hourly_rate ORDER BY u.full_name,t.hourly_rate",
      { bind: [id] },
    );
    return { ...rows[0], labor };
  }
  async orgDashboard(user, org, input, transaction) {
    if (!transaction)
      return this.db.transaction({ isolationLevel: "REPEATABLE READ" }, (t) =>
        this.orgDashboard(user, org, input, t),
      );
    const time = await this.timeReport(user, input, org, transaction);
    const [materials] = await this.db.query(
      "SELECT COALESCE(sum(pi.qty*pi.unit_cost),0)::text AS material_cost FROM project_inventory pi JOIN project_subdivisions s ON s.id=pi.subdivision_id WHERE s.awarded_org_id=$1 AND pi.consumed_at >= $2::date AND pi.consumed_at < $3::date + interval '1 day'",
      { bind: [org, time.from, time.to], transaction },
    );
    return { ...time, ...materials[0] };
  }
}
module.exports = { PlatformService, publicUser };
