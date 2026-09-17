const { Op } = require("sequelize");
const bcrypt = require("bcryptjs");
const { randomBytes } = require("node:crypto");
const { schemas, check } = require("./validation.cjs");
const publicUser = (user) => {
  const { password_hash, ...value } = user.get({ plain: true });
  return value;
};
class PlatformService {
  constructor({ db, models }) {
    this.db = db;
    this.m = models;
    // Extension point for other services to gate bidding/awarding inside the
    // same transaction. Nothing is registered by default: credentials, for
    // example, are shown to the client rather than enforced here.
    this.bidRules = [];
    this.awardHooks = [];
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
    const d = schemas.profile.parse(input);
    if (d.resume_file_id) {
      const file = await this.m.File.findByPk(d.resume_file_id);
      check(
        file && file.uploaded_by_user_id === user,
        403,
        "Attach only a file you uploaded",
      );
    }
    await row.update(d);
    return publicUser(row);
  }
  // A resume is visible to its owner and to anyone who can review a job
  // application it was attached to — the poster, or a manager of the
  // posting organization.
  async canViewResume(user, fileId) {
    const owner = await this.m.User.findOne({
      where: { resume_file_id: fileId },
      attributes: ["id"],
    });
    if (!owner) return false;
    if (owner.id === user) return true;
    const applications = await this.m.JobApplication.findAll({
      where: { applicant_user_id: owner.id },
      include: [{ model: this.m.JobPosting, as: "posting" }],
    });
    for (const a of applications) {
      if (a.posting.posted_by_user_id === user) return true;
      if (a.posting.posted_by_org_id) {
        const membership = await this.m.OrganizationMember.findOne({
          where: { user_id: user, org_id: a.posting.posted_by_org_id },
        });
        if (membership?.canManage()) return true;
      }
    }
    return false;
  }
  async switchContext(user, input) {
    const d = schemas.context.parse(input);
    if (d.org_id) await this.member(user, d.org_id, null, true);
    return d;
  }
  async notify(user, org, actor, title, body, route, transaction) {
    const recipients = new Set(user ? [user] : []);
    if (org) {
      const members = await this.m.OrganizationMember.findAll({
        where: { org_id: org },
        transaction,
      });
      for (const member of members)
        if (["owner", "manager"].includes(member.internal_role))
          recipients.add(member.user_id);
    }
    recipients.delete(actor);
    await this.m.Notification.bulkCreate(
      [...recipients].map((user_id) => ({ user_id, title, body, route })),
      { transaction },
    );
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
      await this.notify(
        job.posted_by_user_id,
        job.posted_by_org_id,
        user,
        "New pay request",
        `A candidate sent a pay request for ${job.title}.`,
        `job/${job.id}`,
        t,
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
      await this.notify(
        job.posted_by_user_id,
        job.posted_by_org_id,
        user,
        "New application",
        `Someone applied for ${job.title}. Review their application and requested pay.`,
        `job/${job.id}`,
        t,
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
      const employerAction = ["offered", "rejected"].includes(action);
      await this.notify(
        employerAction ? app.applicant_user_id : job.posted_by_user_id,
        employerAction ? null : job.posted_by_org_id,
        user,
        `Application ${action}`,
        `${job.title}: the application is now ${action}. Open the details to review current terms.`,
        employerAction ? "jobs/applications" : `job/${job.id}`,
        t,
      );
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
    const { subdivisions, org_id, ...d } = schemas.project.parse(input);
    return this.db.transaction(async (t) => {
      if (org_id) await this.member(user, org_id, t, true);
      const p = await this.m.Project.create(
        {
          ...d,
          client_user_id: user,
          client_org_id: org_id || null,
          status: "open",
        },
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
      for (const rule of this.bidRules)
        await rule(
          {
            user,
            userId: org_id ? null : user,
            orgId: org_id || null,
            s,
            p,
            phase: "bid",
          },
          t,
        );
      const parent = s.parent_subdivision_id
        ? await this.get("ProjectSubdivision", s.parent_subdivision_id, t)
        : null;
      await this.notify(
        p.client_user_id,
        null,
        user,
        "New project bid",
        `A bid was submitted for ${s.scope}.`,
        `project/${p.id}`,
        t,
      );
      if (parent && parent.awarded_user_id !== p.client_user_id)
        await this.notify(
          parent.awarded_user_id,
          parent.awarded_org_id,
          user,
          "New subcontract bid",
          `A bid was submitted for ${s.scope}.`,
          `project/${p.id}`,
          t,
        );
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
      for (const rule of this.bidRules)
        await rule(
          {
            user,
            userId: b.bidding_user_id,
            orgId: b.bidding_org_id,
            s,
            p,
            phase: "award",
          },
          t,
        );
      await this.m.Bid.update(
        { status: "rejected" },
        { where: { subdivision_id: s.id, status: "pending" }, transaction: t },
      );
      await b.update({ status: "accepted" }, { transaction: t });
      await this.notify(
        b.bidding_user_id,
        b.bidding_org_id,
        user,
        "Bid awarded",
        `Your bid for ${s.scope} was awarded.`,
        `project/${p.id}`,
        t,
      );
      await s.update(
        {
          awarded_user_id: b.bidding_user_id,
          awarded_org_id: b.bidding_org_id,
          status: "awarded",
        },
        { transaction: t },
      );
      await p.update({ status: "active" }, { transaction: t });
      for (const hook of this.awardHooks) await hook(user, s, b, t);
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
  async logTimeBulk(user, input) {
    const d = schemas.timeBulk.parse(input);
    return this.db.transaction(async (t) => {
      const { s } = await this.work(d.subdivision_id, t);
      await this.performer(user, s, t);
      check(
        d.org_id === undefined || d.org_id === s.awarded_org_id,
        403,
        "Organization does not match awarded work",
      );
      const u = await this.get("User", user, t, true);
      const rate = await this.effectiveRate(u, s.awarded_org_id, t);
      // Combine same-date rows so 24h checks see the true daily total, then
      // validate each affected date once against existing saved entries plus
      // every new entry being added for that date in this batch.
      const byDate = new Map();
      for (const entry of d.entries)
        byDate.set(
          entry.date,
          (byDate.get(entry.date) || 0) + Math.round(entry.hours * 100),
        );
      for (const [entryDate, addedHours] of byDate) {
        const existing =
          (await this.m.Timesheet.sum("hours", {
            where: { user_id: user, date: entryDate },
            transaction: t,
          })) || 0;
        check(
          Math.round(Number(existing) * 100) + addedHours <= 2400,
          409,
          `Daily time exceeds 24 hours on ${entryDate}`,
        );
      }
      return this.m.Timesheet.bulkCreate(
        d.entries.map((entry) => ({
          subdivision_id: d.subdivision_id,
          hours: entry.hours,
          start_time: entry.start_time,
          end_time: entry.end_time,
          date: entry.date,
          note: entry.note,
          user_id: user,
          org_id: s.awarded_org_id || null,
          hourly_rate: rate,
        })),
        { transaction: t, returning: true },
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
      // Revalidate the merged interval; changing clocks derives a fresh duration.
      const clocksChanged =
        d.start_time !== undefined || d.end_time !== undefined;
      const next = schemas.time.parse({
        subdivision_id: row.subdivision_id,
        date: d.date || row.date,
        note: d.note ?? row.note,
        start_time:
          d.start_time !== undefined
            ? d.start_time
            : row.start_time?.slice(0, 5) || null,
        end_time:
          d.end_time !== undefined
            ? d.end_time
            : row.end_time?.slice(0, 5) || null,
        ...(!clocksChanged || (d.start_time === null && d.end_time === null)
          ? { hours: Number(d.hours ?? row.hours) }
          : {}),
      });
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
        Math.round(Number(total) * 100) + Math.round(next.hours * 100) <= 2400,
        409,
        "Daily time exceeds 24 hours",
      );
      return row.update(next, { transaction: t });
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
      `SELECT subdivision_id,user_id,date,start_time,end_time,hourly_rate::text AS hourly_rate,sum(hours)::text AS hours,sum(round(hours*hourly_rate,2))::text AS labor_cost FROM timesheets WHERE ${where}=$actor AND date BETWEEN $from AND $to GROUP BY subdivision_id,user_id,date,start_time,end_time,hourly_rate ORDER BY date,subdivision_id,user_id`,
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
  // --- Account deletion -----------------------------------------------------
  // WorkOrder cannot cascade a user away: awarded work, recorded hours, funded
  // scopes, payouts, lien waivers, signed field documents, disputes and reviews
  // are other people's financial and legal records, and several of those tables
  // are append-only by trigger. Deletion therefore hard-deletes what is purely
  // personal and anonymises the account row that the retained records point at,
  // so their integrity — and every other party's view of them — survives.
  //
  // Organizations the user is the only member of are treated as extensions of
  // that user: their in-flight work and money block deletion too.
  async soloOrgs(actor, t) {
    const memberships = await this.m.OrganizationMember.findAll({
      where: { user_id: actor },
      transaction: t,
    });
    const solo = [];
    for (const m of memberships)
      if (
        !(await this.m.OrganizationMember.count({
          where: { org_id: m.org_id, user_id: { [Op.ne]: actor } },
          transaction: t,
        }))
      )
        solo.push(m.org_id);
    return { memberships, solo };
  }
  // Every reason the account cannot leave yet, each phrased as the next step.
  async deletionBlockers(actor, memberships, solo, t) {
    const blockers = [];
    const plural = (n, one, many) => (n === 1 ? one : many);
    const count = (model, where) =>
      this.m[model].count({ where, transaction: t });
    // Postgres rejects a bind list longer than the statement's placeholders, so
    // only pass the solo-organization array to the queries that reference it.
    const scalar = async (text) => {
      const bind = [actor];
      if (text.includes("$2")) bind.push(solo.length ? solo : [0]);
      const [rows] = await this.db.query(text, { bind, transaction: t });
      return Number(rows[0].total);
    };
    for (const m of memberships) {
      if (m.internal_role !== "owner") continue;
      const others = await count("OrganizationMember", {
        org_id: m.org_id,
        user_id: { [Op.ne]: actor },
      });
      const owners = await count("OrganizationMember", {
        org_id: m.org_id,
        user_id: { [Op.ne]: actor },
        internal_role: "owner",
      });
      if (others && !owners) {
        const org = await this.get("Organization", m.org_id, t);
        blockers.push(
          `You are the only owner of ${org.name}. Make another member an owner, or remove its ${others} other ${plural(others, "member", "members")}, before deleting your account.`,
        );
      }
    }
    const awarded = await count("ProjectSubdivision", {
      status: { [Op.in]: ["awarded", "active"] },
      [Op.or]: [
        { awarded_user_id: actor },
        ...(solo.length ? [{ awarded_org_id: { [Op.in]: solo } }] : []),
      ],
    });
    if (awarded)
      blockers.push(
        `${awarded} awarded ${plural(awarded, "scope is", "scopes are")} still in flight. Awarded work cannot be reassigned, so mark it complete — or ask the client to close it out — before deleting your account.`,
      );
    const active = await scalar(
      "SELECT count(*)::text AS total FROM projects WHERE client_user_id=$1 AND status='active' AND (client_org_id IS NULL OR client_org_id = ANY($2))",
    );
    if (active)
      blockers.push(
        `${active} of your ${plural(active, "projects still has", "projects still have")} work underway. Close out every awarded scope on ${plural(active, "it", "them")} first.`,
      );
    const unreleased = await scalar(
      `SELECT count(*)::text AS total FROM scope_fundings f WHERE f.funded_by_user_id=$1 AND (f.status IN ('pending','processing') OR f.amount_received
         - COALESCE((SELECT sum(r.amount) FROM scope_refunds r WHERE r.funding_id=f.id AND r.status IN ('processing','succeeded')),0)
         - COALESCE((SELECT sum(l.amount - l.amount_reversed) FROM scope_releases l WHERE l.funding_id=f.id AND l.status IN ('processing','paid')),0) > 0)`,
    );
    if (unreleased)
      blockers.push(
        `You still have funded money on ${unreleased} ${plural(unreleased, "scope", "scopes")} that has not been released or refunded. Release or refund it first.`,
      );
    const owed = await scalar(
      `SELECT (SELECT count(*) FROM scope_releases l JOIN payment_accounts a ON a.id=l.payment_account_id WHERE l.status='processing' AND (a.owner_user_id=$1 OR a.owner_org_id = ANY($2)))
            + (SELECT count(*) FROM provider_payouts p JOIN payment_accounts a ON a.id=p.payment_account_id WHERE p.status IN ('requested','pending','in_transit') AND (a.owner_user_id=$1 OR a.owner_org_id = ANY($2))) AS total`,
    );
    if (owed)
      blockers.push(
        `${owed} ${plural(owed, "payment is", "payments are")} still on the way to your payment account. Wait for ${plural(owed, "it", "them")} to settle, and withdraw your remaining balance, before deleting your account.`,
      );
    const disputes = await scalar(
      `SELECT count(*)::text AS total FROM disputes d JOIN project_subdivisions s ON s.id=d.subdivision_id JOIN projects p ON p.id=s.project_id
        WHERE d.status='open' AND (d.opened_by_user_id=$1 OR p.client_user_id=$1 OR s.awarded_user_id=$1 OR s.awarded_org_id = ANY($2))`,
    );
    if (disputes)
      blockers.push(
        `${disputes} ${plural(disputes, "dispute is", "disputes are")} still open on work you are party to. Resolve or withdraw ${plural(disputes, "it", "them")} first.`,
      );
    const waivers = await scalar(
      "SELECT count(*)::text AS total FROM lien_waivers WHERE status='requested' AND (claimant_user_id=$1 OR claimant_org_id = ANY($2))",
    );
    if (waivers)
      blockers.push(
        `${waivers} lien ${plural(waivers, "waiver is", "waivers are")} waiting for your signature. Sign or void ${plural(waivers, "it", "them")} first.`,
      );
    return blockers;
  }
  async deleteAccount(actor, input) {
    const confirmation =
      typeof input?.confirm_email === "string"
        ? input.confirm_email.trim().toLowerCase()
        : "";
    // Hashing is slow; do it before the transaction so no row lock waits on it.
    const tombstone = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
    return this.db.transaction(async (t) => {
      const user = await this.get("User", actor, t, true);
      check(
        confirmation === user.email,
        422,
        "Type the email address on this account to confirm deletion",
      );
      const { memberships, solo } = await this.soloOrgs(actor, t);
      const blockers = await this.deletionBlockers(actor, memberships, solo, t);
      check(!blockers.length, 409, blockers.join(" "));
      const orgList = solo.length ? solo : [0];
      const sql = (text) =>
        this.db.query(text, {
          bind: text.includes("$2") ? [actor, orgList] : [actor],
          transaction: t,
        });
      // Wind down open offers so nobody is left waiting on an absent account.
      await this.m.Bid.update(
        { status: "withdrawn" },
        {
          where: {
            status: "pending",
            [Op.or]: [
              { bidding_user_id: actor },
              ...(solo.length ? [{ bidding_org_id: { [Op.in]: solo } }] : []),
            ],
          },
          transaction: t,
        },
      );
      // A project only stays "open" while nothing on it is awarded, so
      // cancelling one here can never strand work someone is performing.
      await sql(
        `UPDATE bids SET status='rejected' WHERE status='pending' AND subdivision_id IN (
           SELECT s.id FROM project_subdivisions s JOIN projects p ON p.id=s.project_id
            WHERE p.client_user_id=$1 AND p.status='open' AND (p.client_org_id IS NULL OR p.client_org_id = ANY($2)))`,
      );
      await sql(
        `UPDATE project_subdivisions SET status='cancelled' WHERE project_id IN (
           SELECT id FROM projects WHERE client_user_id=$1 AND status='open' AND (client_org_id IS NULL OR client_org_id = ANY($2)))`,
      );
      await sql(
        "UPDATE projects SET status='cancelled' WHERE client_user_id=$1 AND status='open' AND (client_org_id IS NULL OR client_org_id = ANY($2))",
      );
      await sql(
        `UPDATE job_applications SET status='rejected' WHERE status IN ('pending','offered') AND job_posting_id IN (
           SELECT id FROM job_postings WHERE posted_by_user_id=$1 AND status='open' AND (posted_by_org_id IS NULL OR posted_by_org_id = ANY($2)))`,
      );
      await sql(
        "UPDATE job_postings SET status='closed' WHERE posted_by_user_id=$1 AND status='open' AND (posted_by_org_id IS NULL OR posted_by_org_id = ANY($2))",
      );
      // Hard-delete what is only ever this person's.
      await this.m.JobApplication.destroy({
        where: { applicant_user_id: actor, status: { [Op.ne]: "accepted" } },
        transaction: t,
      });
      // An accepted application is the other party's hiring record; only the
      // free-text negotiation carried on it is personal.
      await this.m.JobApplication.update(
        { negotiation: [] },
        { where: { applicant_user_id: actor }, transaction: t },
      );
      await this.m.Notification.destroy({
        where: { user_id: actor },
        transaction: t,
      });
      await this.m.Credential.destroy({
        where: { owner_user_id: actor },
        transaction: t,
      });
      await this.m.OrganizationMember.destroy({
        where: { user_id: actor },
        transaction: t,
      });
      await sql("DELETE FROM field_time_batches WHERE user_id=$1");
      await sql("DELETE FROM sessions WHERE sess->>'userId' = $1::text");
      // auth_tokens and device_tokens arrive in separate migrations; clear them
      // only once they exist so this works before and after those land.
      for (const table of ["auth_tokens", "device_tokens"]) {
        const [present] = await this.db.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='user_id'",
          { bind: [table], transaction: t },
        );
        if (present.length)
          await this.db.query(`DELETE FROM ${table} WHERE user_id=$1`, {
            bind: [actor],
            transaction: t,
          });
      }
      // Anonymize the row every retained record still points at. The address is
      // unique, unroutable and not the one the person signed up with, so the
      // account cannot be signed into and the old address is free to reuse.
      await user.update(
        {
          full_name: "Deleted user",
          email: `deleted-user-${user.id}@deleted.invalid`,
          password_hash: tombstone,
          skills: [],
          hourly_rate: 0,
          availability_status: "unavailable",
          platform_role: "user",
          resume_file_id: null,
        },
        { transaction: t },
      );
      // Uploaded files last: by now the resume and credentials that referenced
      // them are gone, and anything still cited by a retained record stays.
      await sql(
        `DELETE FROM files f WHERE f.uploaded_by_user_id=$1
           AND NOT EXISTS (SELECT 1 FROM credentials c WHERE c.file_id=f.id)
           AND NOT EXISTS (SELECT 1 FROM dispute_events e WHERE e.file_id=f.id)
           AND NOT EXISTS (SELECT 1 FROM field_documents d WHERE d.file_id=f.id)
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.resume_file_id=f.id)
           AND NOT EXISTS (SELECT 1 FROM daily_reports r WHERE r.file_ids @> to_jsonb(f.id))`,
      );
      return { deleted: true };
    });
  }
  // HTTP adapter for the route above: the domain work stays in deleteAccount,
  // and the session teardown mirrors POST /api/auth/logout.
}
module.exports = { PlatformService, publicUser };
