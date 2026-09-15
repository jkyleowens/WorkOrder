const { z } = require("zod");
const id = z.number().int().positive().max(2147483647);
const text = (max = 200) => z.string().trim().min(1).max(max);
const money = z
  .number()
  .finite()
  .min(0)
  .max(9999999999.99)
  .refine(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001,
    "At most two decimal places",
  );
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
    "Invalid date",
  );
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timeFields = {
  hours: z
    .number()
    .positive()
    .max(24)
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001)
    .optional(),
  start_time: clockTime.nullable().optional(),
  end_time: z
    .union([clockTime, z.literal("24:00")])
    .nullable()
    .optional(),
};
function normalizeTime(d, ctx) {
  const start = d.start_time,
    end = d.end_time;
  if (start == null && end == null) {
    if (d.hours === undefined)
      ctx.addIssue({
        code: "custom",
        message: "Enter start and end times or hours",
      });
    return d;
  }
  if (start == null || end == null) {
    ctx.addIssue({ code: "custom", message: "Enter both start and end times" });
    return d;
  }
  const minutes = (value) =>
    Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const finish = end === "00:00" ? "24:00" : end;
  const duration = minutes(finish) - minutes(start);
  if (duration <= 0)
    ctx.addIssue({
      code: "custom",
      message:
        "End time must be after start time. Split overnight work across dates.",
    });
  const hours = Math.round((duration / 60) * 100) / 100;
  if (d.hours !== undefined && d.hours !== hours)
    ctx.addIssue({
      code: "custom",
      message: "Hours must match start and end times",
    });
  return { ...d, start_time: start, end_time: finish, hours };
}
const profile = {
  full_name: text(120),
  skills: z.array(text(80)).max(50),
  hourly_rate: money,
  availability_status: z.enum(["available", "busy", "unavailable"]),
  resume_file_id: id.nullable(),
};
const schemas = {
  register: z
    .object({
      full_name: profile.full_name,
      email: z
        .email()
        .max(254)
        .transform((s) => s.toLowerCase()),
      password: z
        .string()
        .min(12)
        .refine((s) => Buffer.byteLength(s) <= 72, "Password exceeds 72 bytes"),
    })
    .strict(),
  login: z
    .object({
      email: z
        .email()
        .max(254)
        .transform((s) => s.toLowerCase()),
      password: z.string().min(1).max(200),
    })
    .strict(),
  profile: z.object(profile).partial().strict(),
  organization: z
    .object({
      name: text(160),
      organization_types: z
        .array(
          z.enum([
            "contractor",
            "supplier",
            "labor_union",
            "client",
            "consultant",
            "other",
          ]),
        )
        .max(6)
        .refine((v) => new Set(v).size === v.length, "Choose each type once")
        .optional(),
      trade_focus: z.string().trim().max(160).default(""),
    })
    .strict(),
  member: z
    .object({ user_id: id, internal_role: z.enum(["manager", "member"]) })
    .strict(),
  companyRole: z
    .object({
      name: text(160),
      description: z.string().trim().max(10000).default(""),
      skills: z.array(text(80)).max(50).default([]),
      hourly_rate: money,
    })
    .strict(),
  memberPay: z
    .object({
      user_id: id,
      company_role_id: id.nullable(),
      hourly_rate: money.nullable(),
    })
    .strict(),
  application: z
    .object({
      desired_rate: money.optional(),
      note: z.string().trim().max(2000).default(""),
    })
    .strict(),
  counter: z
    .object({
      desired_rate: money,
      note: z.string().trim().max(2000).default(""),
      revision: z.number().int().min(0),
    })
    .strict(),
  acceptance: z
    .object({ revision: z.number().int().min(0).optional() })
    .strict(),
  context: z
    .object({
      mode: z.enum(["personal", "client", "organization"]),
      org_id: id.optional(),
    })
    .strict()
    .refine(
      (d) => (d.mode === "organization") === (d.org_id !== undefined),
      "Organization context requires org_id only",
    ),
  job: z
    .object({
      title: text(),
      description: text(10000),
      org_id: id.optional(),
      company_role_id: id.optional(),
      hourly_rate: money.optional(),
    })
    .strict(),
  decision: z
    .object({
      status: z.enum(["offered", "rejected"]),
      offered_rate: money.optional(),
      note: z.string().trim().max(2000).default(""),
      revision: z.number().int().min(0).optional(),
    })
    .strict(),
  project: z
    .object({
      title: text(),
      description: z.string().max(10000).default(""),
      subdivisions: z.array(text(10000)).min(1).max(100).optional(),
      org_id: id.optional(),
    })
    .strict(),
  subdivision: z
    .object({ scopes: z.array(text(10000)).min(1).max(100) })
    .strict(),
  bid: z
    .object({ amount: money.refine((n) => n > 0), org_id: id.optional() })
    .strict(),
  subdivisionStatus: z
    .object({ status: z.enum(["active", "completed"]) })
    .strict(),
  inventory: z
    .object({
      item_name: text(),
      stock: z.number().int().min(0).max(2147483647),
      unit: text(40).default("each"),
      unit_cost: money.default(0),
      org_id: id.optional(),
    })
    .strict(),
  receipt: z
    .object({
      quantity: z.number().int().positive().max(2147483647),
      reason: text(500),
      unit_cost: money.optional(),
    })
    .strict(),
  consume: z
    .object({ item_id: id, qty: z.number().int().positive().max(2147483647) })
    .strict(),
  time: z
    .object({
      subdivision_id: id,
      ...timeFields,
      date,
      note: z.string().max(2000).default(""),
      org_id: id.optional(),
    })
    .strict()
    .transform(normalizeTime),
  timeEdit: z
    .object({
      ...timeFields,
      date: date.optional(),
      note: z.string().max(2000).optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0, "Provide a field to update"),
  timeBulk: z
    .object({
      subdivision_id: id,
      org_id: id.optional(),
      entries: z
        .array(
          z
            .object({
              ...timeFields,
              date,
              note: z.string().max(2000).default(""),
            })
            .strict()
            .transform(normalizeTime),
        )
        .min(1)
        .max(31),
    })
    .strict(),
  range: z
    .object({ from: date, to: date })
    .strict()
    .refine(
      (d) =>
        d.from <= d.to &&
        (Date.parse(d.to) - Date.parse(d.from)) / 86400000 <= 366,
      "Range must be ordered and at most 366 days",
    ),
  page: z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
    })
    .strict(),
};
class DomainError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function check(condition, status = 409, message = "Invalid state transition") {
  if (!condition) throw new DomainError(status, message);
}
module.exports = { schemas, id, date, check, DomainError };
