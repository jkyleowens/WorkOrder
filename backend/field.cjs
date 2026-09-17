const { z } = require("zod");
const { createHash } = require("node:crypto");
const { Op } = require("sequelize");
const { check, date, schemas: platformSchemas } = require("./validation.cjs");
const id = z.number().int().positive().max(2147483647);
const text = z.string().trim().max(10000);
const hash = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const addDays = (d, n) =>
  new Date(Date.parse(d + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
const schemas = {
  time: z
    .object({
      request_key: z.uuid(),
      subdivision_id: id,
      user_ids: z
        .array(id)
        .min(1)
        .max(100)
        .refine((v) => new Set(v).size === v.length),
      entries: z
        .array(
          z
            .object({
              date,
              start_time: z.string(),
              end_time: z.string(),
              note: text.default(""),
              // Captured on the device at the moment of the clock event, not at
              // sync time — a queued entry may not reach the server for hours,
              // by which point the crew is somewhere else entirely. Optional
              // throughout: a refused permission must never block recording time.
              clock_latitude: z.number().min(-90).max(90).nullish(),
              clock_longitude: z.number().min(-180).max(180).nullish(),
              clock_accuracy_m: z.number().min(0).max(100000).nullish(),
            })
            // A lone coordinate is not a location, and the table refuses it
            // anyway; rejecting it here says so in words instead of as a
            // constraint violation.
            .refine(
              (e) => (e.clock_latitude == null) === (e.clock_longitude == null),
              {
                message:
                  "A clock location needs both latitude and longitude, or neither",
              },
            ),
        )
        .min(1)
        .max(31),
    })
    .strict(),
  report: z
    .object({
      report_date: date,
      progress: text.min(1),
      headcount: z.number().int().min(0).max(10000),
      weather: z.string().trim().max(1000).default(""),
      deliveries: text.default(""),
      delays: text.default(""),
      file_ids: z.array(id).max(12).default([]),
    })
    .strict(),
  schedule: z
    .object({
      planned_start: date.nullable(),
      duration_days: z.number().int().min(1).max(3650),
      predecessor_id: id.nullable(),
      expected_version: z.number().int().min(0),
    })
    .strict(),
  document: z
    .object({
      title: z.string().trim().min(1).max(200),
      body: text,
      kind: z
        .enum(["scope", "certificate", "waiver", "other"])
        .default("other"),
      file_id: id.optional(),
      previous_id: id.optional(),
    })
    .strict()
    .refine((v) => v.body || v.file_id, "Write text or attach a document"),
  sign: z
    .object({
      party: z.enum(["payer", "contractor", "client"]),
      signer_name: z.string().trim().min(2).max(120),
      content_hash: z.string().length(64),
      confirm: z.literal(true),
    })
    .strict(),
};
class FieldService {
  constructor(platform, billing, files, trust) {
    this.p = platform;
    this.b = billing;
    this.files = files;
    this.db = platform.db;
    this.m = platform.m;
    platform.awardHooks.push((user, s, b, t) => this.agreement(user, s, t));
    files.rules.push((user, file) => this.fileAccess(user, file));
    trust.packetSources.push((scope, t) => this.evidence(scope, t));
  }
  async query(sql, bind = [], t) {
    return (await this.db.query(sql, { bind, transaction: t }))[0];
  }
  async membership(user, org, t) {
    return org
      ? this.m.OrganizationMember.findOne({
          where: { user_id: user, org_id: org },
          transaction: t,
        })
      : null;
  }
  async access(user, scope, t, write = false) {
    const { p, s } = await this.p.work(scope, t);
    const member = await this.membership(user, s.awarded_org_id, t);
    const performer = s.awarded_user_id === user || !!member;
    const manage = s.awarded_user_id === user || !!member?.canManage();
    let reader = p.client_user_id === user || performer;
    let ancestor = s;
    while (!reader && ancestor.parent_subdivision_id) {
      ancestor = await this.p.get(
        "ProjectSubdivision",
        ancestor.parent_subdivision_id,
        t,
      );
      reader =
        ancestor.awarded_user_id === user ||
        !!(
          await this.membership(user, ancestor.awarded_org_id, t)
        )?.canManage();
    }
    check(
      write ? performer : reader,
      403,
      "Field records are available only to this crew and its commissioning parties",
    );
    if (write)
      check(
        ["awarded", "active"].includes(s.status),
        409,
        "This scope is no longer active; review the queued work before resubmitting",
      );
    return { p, s, performer, manage };
  }
  async projectAccess(user, project, t) {
    const p = await this.p.get("Project", project, t, true);
    if (p.client_user_id === user) return p;
    const scopes = await this.m.ProjectSubdivision.findAll({
      where: { project_id: project },
      transaction: t,
    });
    for (const s of scopes) {
      if (
        s.awarded_user_id === user ||
        (await this.membership(user, s.awarded_org_id, t))
      )
        return p;
    }
    check(false, 403, "Project field access denied");
  }
  async bootstrap(user) {
    return this.db.transaction(async (t) => {
      const memberships = await this.m.OrganizationMember.findAll({
        where: { user_id: user },
        transaction: t,
      });
      const projects = await this.m.Project.findAll({
        where: { client_user_id: user },
        transaction: t,
      });
      const scopes = await this.m.ProjectSubdivision.findAll({
        where: {
          [Op.or]: [
            { awarded_user_id: user },
            { awarded_org_id: memberships.map((x) => x.org_id) },
            { project_id: projects.map((x) => x.id) },
          ],
        },
        transaction: t,
        order: [["id", "ASC"]],
      });
      const projectIds = [...new Set(scopes.map((s) => s.project_id))];
      const result = [];
      for (const projectId of projectIds) {
        const schedule = await this.schedule(user, projectId, t);
        result.push(...schedule.scopes);
      }
      const crew = {};
      for (const m of memberships.filter((m) => m.canManage())) {
        const members = await this.m.OrganizationMember.findAll({
          where: { org_id: m.org_id },
          transaction: t,
        });
        const users = await this.m.User.findAll({
          where: { id: members.map((x) => x.user_id) },
          attributes: ["id", "full_name"],
          transaction: t,
        });
        crew[m.org_id] = users;
      }
      return {
        user_id: user,
        generated_at: new Date().toISOString(),
        scopes: result,
        crew,
      };
    });
  }
  async syncTime(user, input) {
    const d = schemas.time.parse(input),
      fingerprint = hash(d);
    // platformSchemas.time is strict and shared with the console's own time
    // entry, which has no location. Keep the coordinates out of that parse and
    // reattach them after, rather than widening a schema other callers use.
    const entries = d.entries.map(
      ({ clock_latitude, clock_longitude, clock_accuracy_m, ...e }) => ({
        ...platformSchemas.time.parse({
          ...e,
          subdivision_id: d.subdivision_id,
        }),
        clock_latitude: clock_latitude ?? null,
        clock_longitude: clock_longitude ?? null,
        clock_accuracy_m: clock_accuracy_m ?? null,
      }),
    );
    return this.db.transaction(async (t) => {
      const { s } = await this.p.work(d.subdivision_id, t);
      // All time writers take project then worker locks; sorted crew locks prevent deadlocks.
      const users = [];
      for (const userId of [...new Set([user, ...d.user_ids])].sort(
        (a, b) => a - b,
      ))
        users.push(await this.p.get("User", userId, t, true));
      const [prior] = await this.query(
        "SELECT * FROM field_time_batches WHERE user_id=$1 AND request_key=$2",
        [user, d.request_key],
        t,
      );
      if (prior) {
        check(
          prior.payload_hash === fingerprint,
          409,
          "This sync key was already used for different time",
        );
        return { ids: prior.timesheet_ids, replayed: true };
      }
      await this.p.performer(
        user,
        s,
        t,
        d.user_ids.some((x) => x !== user),
      );
      const saved = [];
      for (const userId of d.user_ids) {
        await this.p.performer(userId, s, t);
        const rate = await this.p.effectiveRate(
          users.find((u) => u.id === userId),
          s.awarded_org_id,
          t,
        );
        const existing = await this.m.Timesheet.findAll({
          where: {
            user_id: userId,
            date: [...new Set(entries.map((e) => e.date))],
          },
          transaction: t,
        });
        const combined = [...existing];
        for (const e of entries) {
          const same = combined.filter((x) => x.date === e.date);
          const minutes = (v) =>
            v === "00:00"
              ? 1440
              : Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
          const start =
            Number(e.start_time.slice(0, 2)) * 60 +
            Number(e.start_time.slice(3, 5));
          const end = minutes(e.end_time);
          check(
            !same.some(
              (x) =>
                !x.start_time ||
                (start < minutes(x.end_time.slice(0, 5)) &&
                  end >
                    Number(x.start_time.slice(0, 2)) * 60 +
                      Number(x.start_time.slice(3, 5))),
            ),
            409,
            `Time conflict for worker ${userId} on ${e.date}. Review existing hours; no queued rows were saved.`,
          );
          check(
            same.reduce((n, x) => n + Math.round(Number(x.hours) * 100), 0) +
              Math.round(e.hours * 100) <=
              2400,
            409,
            `Daily time exceeds 24 hours for worker ${userId}`,
          );
          combined.push(e);
        }
        for (const e of entries)
          saved.push(
            await this.m.Timesheet.create(
              {
                ...e,
                user_id: userId,
                org_id: s.awarded_org_id || null,
                hourly_rate: rate,
              },
              { transaction: t },
            ),
          );
      }
      const ids = saved.map((x) => x.id);
      await this.query(
        "INSERT INTO field_time_batches(user_id,request_key,payload_hash,timesheet_ids) VALUES($1,$2,$3,$4::jsonb)",
        [user, d.request_key, fingerprint, JSON.stringify(ids)],
        t,
      );
      return { ids, replayed: false };
    });
  }
  async report(user, scope, input) {
    const d = schemas.report.parse(input);
    return this.db.transaction(async (t) => {
      await this.access(user, scope, t, true);
      for (const file of d.file_ids) {
        const f = await this.files.ensureUploader(user, file, t);
        check(
          f.content_type.startsWith("image/"),
          422,
          "Daily report attachments must be photos",
        );
      }
      const [r] = await this.query(
        "INSERT INTO daily_reports(subdivision_id,author_user_id,report_date,progress,headcount,weather,deliveries,delays,file_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *",
        [
          scope,
          user,
          d.report_date,
          d.progress,
          d.headcount,
          d.weather,
          d.deliveries,
          d.delays,
          JSON.stringify(d.file_ids),
        ],
        t,
      );
      return r;
    });
  }
  async reports(user, scope) {
    return this.db.transaction(async (t) => {
      await this.access(user, scope, t);
      return this.query(
        "SELECT r.*,u.full_name AS author_name FROM daily_reports r JOIN users u ON u.id=r.author_user_id WHERE subdivision_id=$1 ORDER BY report_date DESC,id DESC",
        [scope],
        t,
      );
    });
  }
  async schedule(user, project, t) {
    if (!t) return this.db.transaction((t) => this.schedule(user, project, t));
    const p = await this.projectAccess(user, project, t);
    const rows = await this.m.ProjectSubdivision.findAll({
      where: { project_id: project },
      transaction: t,
      order: [
        ["sequence", "ASC"],
        ["id", "ASC"],
      ],
      raw: true,
    });
    const byId = new Map(rows.map((s) => [s.id, s])),
      visited = new Set();
    const compute = (s) => {
      if (s.computed) return;
      check(!visited.has(s.id), 409, "Schedule contains a dependency cycle");
      visited.add(s.id);
      let start = s.planned_start;
      if (s.predecessor_id) {
        const prev = byId.get(s.predecessor_id);
        check(prev, 409, "Predecessor must be in this project");
        compute(prev);
        if (prev.planned_end) {
          const next = addDays(prev.planned_end, 1);
          if (!start || next > start) start = next;
        }
      }
      s.effective_start = start;
      s.planned_end = start ? addDays(start, s.duration_days - 1) : null;
      s.computed = true;
      visited.delete(s.id);
    };
    for (const s of rows) compute(s);
    const visible = [];
    for (const s of rows) {
      try {
        const a = await this.access(user, s.id, t);
        s.can_record = a.performer && ["awarded", "active"].includes(s.status);
        s.can_schedule = p.client_user_id === user || a.manage;
        s.project_title = p.title;
        s.can_project_document = p.client_user_id === user;
        s.can_document = false;
        if (["awarded", "active", "completed"].includes(s.status)) {
          try {
            const ctx = await this.b.context(user, s.id, t);
            s.can_document = ctx.payer || ctx.contractor;
          } catch (e) {
            if (e.status !== 403) throw e;
          }
        }
        s.can_manage_crew = a.manage && !!s.awarded_org_id;
        visible.push(s);
      } catch (e) {
        if (e.status !== 403) throw e;
      }
    }
    const starts = rows
        .map((x) => x.effective_start)
        .filter(Boolean)
        .sort(),
      ends = rows
        .map((x) => x.planned_end)
        .filter(Boolean)
        .sort();
    return {
      project: {
        id: p.id,
        title: p.title,
        start: starts[0] || null,
        end: ends.at(-1) || null,
      },
      scopes: visible,
    };
  }
  async plan(user, scope, input) {
    const d = schemas.schedule.parse(input);
    return this.db.transaction(async (t) => {
      const { p, s, manage } = await this.access(user, scope, t);
      check(
        p.client_user_id === user || manage,
        403,
        "Only the client or scope manager can change dates",
      );
      check(
        s.schedule_version === d.expected_version,
        409,
        "The schedule changed. Refresh before editing.",
      );
      if (d.predecessor_id) {
        const prev = await this.p.get(
          "ProjectSubdivision",
          d.predecessor_id,
          t,
        );
        check(
          prev.project_id === p.id && prev.id !== s.id,
          422,
          "Choose another scope in the same project",
        );
      }
      await s.update(
        {
          planned_start: d.planned_start,
          duration_days: d.duration_days,
          predecessor_id: d.predecessor_id,
          schedule_version: s.schedule_version + 1,
        },
        { transaction: t },
      );
      return this.schedule(user, p.id, t);
    });
  }
  async parties(s, t) {
    const p = await this.p.get("Project", s.project_id, t);
    const parent = s.parent_subdivision_id
      ? await this.p.get("ProjectSubdivision", s.parent_subdivision_id, t)
      : null;
    return {
      payer: {
        user_id: parent?.awarded_org_id
          ? null
          : parent?.awarded_user_id || p.client_user_id,
        org_id: parent?.awarded_org_id || null,
      },
      contractor: { user_id: s.awarded_user_id, org_id: s.awarded_org_id },
    };
  }
  async agreement(user, s, t) {
    const [prior] = await this.query(
      "SELECT * FROM field_documents WHERE subdivision_id=$1 AND kind='agreement' AND previous_id IS NULL",
      [s.id],
      t,
    );
    if (prior) return prior;
    const bid = await this.m.Bid.findOne({
      where: { subdivision_id: s.id, status: "accepted" },
      transaction: t,
    });
    if (!bid) return null;
    const p = await this.p.get("Project", s.project_id, t),
      parties = await this.parties(s, t);
    const names = {};
    for (const [key, v] of Object.entries(parties))
      names[key] = v.org_id
        ? (await this.p.get("Organization", v.org_id, t)).name
        : (await this.p.get("User", v.user_id, t)).full_name;
    return this.insertDocument(
      user,
      p.id,
      s.id,
      {
        title: `Award agreement · ${s.scope}`,
        kind: "agreement",
        body: `Project: ${p.title}\nScope of work: ${s.scope}\nProject description: ${p.description || ""}\nPaying party: ${names.payer}\nContractor: ${names.contractor}\nAccepted bid: USD ${bid.amount}\nBid record: ${bid.id}\nThe parties acknowledge this scope and accepted bid amount. Changes require a separately accepted change order.`,
        parties,
      },
      t,
    );
  }
  async insertDocument(user, project, scope, d, t) {
    let attachment = null;
    if (d.file_id)
      attachment = await this.files.ensureUploader(user, d.file_id, t);
    const content_hash = hash({
      title: d.title,
      body: d.body,
      kind: d.kind,
      parties: d.parties,
      file_hash: attachment?.sha256 || null,
    });
    const [r] = await this.query(
      "INSERT INTO field_documents(project_id,subdivision_id,previous_id,version,kind,title,body,file_id,parties,content_hash,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *",
      [
        project,
        scope,
        d.previous_id || null,
        d.version || 1,
        d.kind,
        d.title,
        d.body,
        d.file_id || null,
        JSON.stringify(d.parties),
        content_hash,
        user,
      ],
      t,
    );
    return r;
  }
  async documents(user, project, scope = null) {
    return this.db.transaction(async (t) => {
      if (scope) {
        const { s } = await this.access(user, scope, t);
        check(
          s.project_id === project,
          422,
          "Scope does not belong to project",
        );
        await this.agreement(user, s, t);
      } else await this.projectAccess(user, project, t);
      const documents = await this.query(
        "SELECT d.*,NOT EXISTS(SELECT 1 FROM field_documents n WHERE n.previous_id=d.id) AS latest FROM field_documents d WHERE project_id=$1 AND subdivision_id IS NOT DISTINCT FROM $2 ORDER BY id DESC",
        [project, scope],
        t,
      );
      const visible = [];
      for (const d of documents) {
        try {
          await this.documentAccess(user, d, t);
          visible.push(d);
        } catch (e) {
          if (e.status !== 403) throw e;
        }
      }
      return visible;
    });
  }
  async documentAccess(user, d, t) {
    if (d.subdivision_id) {
      await this.access(user, d.subdivision_id, t);
      if (["agreement", "waiver"].includes(d.kind))
        await this.b.context(user, d.subdivision_id, t);
    } else {
      const p = await this.projectAccess(user, d.project_id, t);
      if (["agreement", "waiver"].includes(d.kind))
        check(
          p.client_user_id === user,
          403,
          "This document is private to the project client",
        );
    }
  }
  async addDocument(user, project, scope, input) {
    const d = schemas.document.parse(input);
    return this.db.transaction(async (t) => {
      const p = await this.projectAccess(user, project, t);
      let parties;
      if (scope) {
        const ctx = await this.b.context(user, scope, t);
        check(ctx.p.id === project, 422, "Scope does not belong to project");
        check(
          ctx.payer || ctx.contractor,
          403,
          "Only contracting parties can add documents",
        );
        parties = await this.parties(ctx.s, t);
      } else {
        check(
          p.client_user_id === user,
          403,
          "Only the client can add project documents",
        );
        parties = { client: { user_id: user, org_id: null } };
      }
      if (d.previous_id) {
        const [prev] = await this.query(
          "SELECT * FROM field_documents WHERE id=$1",
          [d.previous_id],
          t,
        );
        check(
          prev && prev.project_id === project && prev.subdivision_id === scope,
          422,
          "Version must belong to the same scope or project",
        );
        check(
          !(
            await this.query(
              "SELECT id FROM field_documents WHERE previous_id=$1",
              [prev.id],
              t,
            )
          ).length,
          409,
          "A newer version already exists",
        );
        d.version = prev.version + 1;
        d.kind = prev.kind;
        parties = prev.parties;
      }
      return this.insertDocument(user, project, scope, { ...d, parties }, t);
    });
  }
  async document(user, id, sign) {
    return this.db.transaction(async (t) => {
      const [d] = await this.query(
        "SELECT * FROM field_documents WHERE id=$1",
        [id],
        t,
      );
      check(d, 404, "Document not found");
      await this.documentAccess(user, d, t);
      const superseded =
        (
          await this.query(
            "SELECT id FROM field_documents WHERE previous_id=$1",
            [id],
            t,
          )
        ).length > 0;
      const canSign = [];
      for (const [key, v] of Object.entries(d.parties)) {
        if (
          v.user_id === user ||
          (v.org_id &&
            !!(await this.membership(user, v.org_id, t))?.canManage())
        )
          canSign.push(key);
      }
      if (sign) {
        const v = schemas.sign.parse(sign);
        check(!superseded, 409, "Sign the latest document version");
        check(canSign.includes(v.party), 403, "You cannot sign for this party");
        check(
          v.content_hash === d.content_hash,
          409,
          "Document contents changed",
        );
        check(
          !(
            await this.query(
              "SELECT id FROM field_document_events WHERE document_id=$1 AND party=$2 AND kind='signed'",
              [id, v.party],
              t,
            )
          ).length,
          409,
          "This party already signed",
        );
        await this.query(
          "INSERT INTO field_document_events(document_id,user_id,kind,party,signer_name,content_hash) VALUES($1,$2,'signed',$3,$4,$5)",
          [id, user, v.party, v.signer_name, d.content_hash],
          t,
        );
      } else
        await this.query(
          "INSERT INTO field_document_events(document_id,user_id,kind,content_hash) VALUES($1,$2,'viewed',$3)",
          [id, user, d.content_hash],
          t,
        );
      const events = await this.query(
        "SELECT e.*,u.full_name FROM field_document_events e JOIN users u ON u.id=e.user_id WHERE document_id=$1 ORDER BY id",
        [id],
        t,
      );
      return {
        ...d,
        superseded,
        events,
        can_edit: canSign.length > 0,
        can_sign: superseded
          ? []
          : canSign.filter(
              (p) => !events.some((e) => e.kind === "signed" && e.party === p),
            ),
      };
    });
  }
  async fileAccess(user, file) {
    const refs = await this.query(
      "SELECT subdivision_id,project_id,kind FROM field_documents WHERE file_id=$1 UNION ALL SELECT subdivision_id,NULL AS project_id,'report' AS kind FROM daily_reports WHERE file_ids @> $2::jsonb",
      [file, JSON.stringify([file])],
    );
    for (const ref of refs) {
      try {
        await this.db.transaction((t) => this.documentAccess(user, ref, t));
        return true;
      } catch (e) {
        if (e.status !== 403) throw e;
      }
    }
    return false;
  }
  async evidence(scope, t) {
    const s = await this.p.get("ProjectSubdivision", scope, t);
    const reports = await this.query(
      "SELECT * FROM daily_reports WHERE subdivision_id=$1 ORDER BY report_date,id",
      [scope],
      t,
    );
    const photos = await this.files.find(
      reports.flatMap((r) => r.file_ids),
      t,
    );
    return {
      daily_reports: reports.map((r) => ({
        ...r,
        photos: photos.filter((p) => r.file_ids.includes(p.id)),
      })),
      documents: await this.query(
        "SELECT d.*,COALESCE((SELECT jsonb_agg(e ORDER BY e.id) FROM field_document_events e WHERE e.document_id=d.id),'[]'::jsonb) AS events FROM field_documents d WHERE subdivision_id=$1 OR (project_id=$2 AND subdivision_id IS NULL) ORDER BY id",
        [scope, s.project_id],
        t,
      ),
    };
  }
}
module.exports = { FieldService, schemas };
