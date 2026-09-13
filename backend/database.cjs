const { Sequelize, DataTypes: D, Model } = require("sequelize");
const fs = require("node:fs/promises");
const path = require("node:path");
const definitions = {
  File: [
    "files",
    {
      uploaded_by_user_id: D.INTEGER,
      filename: D.STRING,
      content_type: D.STRING,
      byte_size: D.INTEGER,
      sha256: D.STRING,
      data: D.BLOB,
      created_at: D.DATE,
    },
  ],
  Credential: [
    "credentials",
    {
      owner_user_id: D.INTEGER,
      owner_org_id: D.INTEGER,
      kind: D.STRING,
      title: D.STRING,
      issuer: D.STRING,
      number: D.STRING,
      jurisdiction: D.STRING,
      coverage_amount: D.DECIMAL,
      effective_on: D.DATEONLY,
      expires_on: D.DATEONLY,
      file_id: D.INTEGER,
      status: D.STRING,
      checked: D.TEXT,
      review_note: D.TEXT,
      reviewed_by_user_id: D.INTEGER,
      reviewed_at: D.DATE,
      created_by_user_id: D.INTEGER,
      created_at: D.DATE,
      updated_at: D.DATE,
    },
  ],
  Review: [
    "reviews",
    {
      subdivision_id: D.INTEGER,
      reviewer_user_id: D.INTEGER,
      reviewer_org_id: D.INTEGER,
      reviewee_user_id: D.INTEGER,
      reviewee_org_id: D.INTEGER,
      schedule: D.INTEGER,
      quality: D.INTEGER,
      communication: D.INTEGER,
      closeout: D.INTEGER,
      comment: D.TEXT,
      contract_value: D.DECIMAL,
      created_at: D.DATE,
    },
  ],
  Dispute: [
    "disputes",
    {
      subdivision_id: D.INTEGER,
      opened_by_user_id: D.INTEGER,
      opened_side: D.STRING,
      reason: D.TEXT,
      amount_held: D.DECIMAL,
      status: D.STRING,
      proposal_contractor: D.DECIMAL,
      proposal_payer: D.DECIMAL,
      proposal_note: D.TEXT,
      proposed_side: D.STRING,
      proposed_by_user_id: D.INTEGER,
      proposed_at: D.DATE,
      resolved_contractor: D.DECIMAL,
      resolved_payer: D.DECIMAL,
      resolution_method: D.STRING,
      resolution_note: D.TEXT,
      resolved_by_user_id: D.INTEGER,
      resolved_at: D.DATE,
      packet: D.JSONB,
      packet_hash: D.STRING,
      created_at: D.DATE,
      updated_at: D.DATE,
    },
  ],
  DisputeEvent: [
    "dispute_events",
    {
      dispute_id: D.INTEGER,
      user_id: D.INTEGER,
      side: D.STRING,
      kind: D.STRING,
      body: D.TEXT,
      file_id: D.INTEGER,
      amount_contractor: D.DECIMAL,
      amount_payer: D.DECIMAL,
      created_at: D.DATE,
    },
  ],
  LienWaiver: [
    "lien_waivers",
    {
      project_id: D.INTEGER,
      subdivision_id: D.INTEGER,
      application_id: D.INTEGER,
      conditional: D.BOOLEAN,
      kind: D.STRING,
      amount: D.DECIMAL,
      through_date: D.DATEONLY,
      claimant_user_id: D.INTEGER,
      claimant_org_id: D.INTEGER,
      payer_user_id: D.INTEGER,
      payer_org_id: D.INTEGER,
      status: D.STRING,
      snapshot: D.JSONB,
      exceptions: D.TEXT,
      signed_by_user_id: D.INTEGER,
      signer_name: D.STRING,
      signer_title: D.STRING,
      signed_at: D.DATE,
      content_hash: D.STRING,
      void_reason: D.TEXT,
      created_at: D.DATE,
      updated_at: D.DATE,
    },
  ],
  PaymentAccount: [
    "payment_accounts",
    {
      owner_user_id: D.INTEGER,
      owner_org_id: D.INTEGER,
      provider: D.STRING,
      provider_account_id: D.STRING,
      country: D.STRING,
      default_currency: D.STRING,
      details_submitted: D.BOOLEAN,
      charges_enabled: D.BOOLEAN,
      payouts_enabled: D.BOOLEAN,
      transfers_active: D.BOOLEAN,
      requirements: D.JSONB,
      created_by_user_id: D.INTEGER,
      created_at: D.DATE,
      updated_at: D.DATE,
    },
  ],
  ScopeFunding: [
    "scope_fundings",
    {
      subdivision_id: D.INTEGER,
      funded_by_user_id: D.INTEGER,
      amount: D.DECIMAL,
      currency: D.STRING,
      status: D.STRING,
      amount_received: D.DECIMAL,
      checkout_session_id: D.STRING,
      checkout_url: D.TEXT,
      payment_intent_id: D.STRING,
      charge_id: D.STRING,
      provider_dispute_status: D.STRING,
      request_key: D.UUID,
      failure_message: D.TEXT,
      created_at: D.DATE,
      updated_at: D.DATE,
    },
  ],
  ScopeRefund: [
    "scope_refunds",
    {
      funding_id: D.INTEGER,
      subdivision_id: D.INTEGER,
      dispute_id: D.INTEGER,
      amount: D.DECIMAL,
      status: D.STRING,
      provider_refund_id: D.STRING,
      reason: D.TEXT,
      requested_by_user_id: D.INTEGER,
      request_key: D.UUID,
      failure_message: D.TEXT,
      created_at: D.DATE,
      updated_at: D.DATE,
    },
  ],
  ScopeRelease: [
    "scope_releases",
    {
      subdivision_id: D.INTEGER,
      application_id: D.INTEGER,
      dispute_id: D.INTEGER,
      funding_id: D.INTEGER,
      payment_account_id: D.INTEGER,
      amount: D.DECIMAL,
      status: D.STRING,
      provider_transfer_id: D.STRING,
      amount_reversed: D.DECIMAL,
      approved_by_user_id: D.INTEGER,
      request_key: D.UUID,
      failure_message: D.TEXT,
      created_at: D.DATE,
      updated_at: D.DATE,
    },
  ],
  ProviderPayout: [
    "provider_payouts",
    {
      payment_account_id: D.INTEGER,
      amount: D.DECIMAL,
      currency: D.STRING,
      status: D.STRING,
      provider_payout_id: D.STRING,
      requested_by_user_id: D.INTEGER,
      request_key: D.UUID,
      failure_message: D.TEXT,
      created_at: D.DATE,
      updated_at: D.DATE,
    },
  ],
  ScopeChangeOrder: [
    "scope_change_orders",
    {
      subdivision_id: D.INTEGER,
      title: D.STRING,
      description: D.TEXT,
      amount: D.DECIMAL,
      schedule_days: D.INTEGER,
      proposed_by_user_id: D.INTEGER,
      proposed_side: D.STRING,
      status: D.STRING,
      decided_by_user_id: D.INTEGER,
      decision_note: D.TEXT,
      created_at: D.DATE,
      decided_at: D.DATE,
    },
  ],
  PayApplication: [
    "pay_applications",
    {
      subdivision_id: D.INTEGER,
      period_from: D.DATEONLY,
      period_to: D.DATEONLY,
      snapshot: D.JSONB,
      amount_due: D.DECIMAL,
      status: D.STRING,
      submitted_by_user_id: D.INTEGER,
      decided_by_user_id: D.INTEGER,
      decision_note: D.TEXT,
      created_at: D.DATE,
      decided_at: D.DATE,
    },
  ],
  BillingPayment: [
    "billing_payments",
    {
      subdivision_id: D.INTEGER,
      application_id: D.INTEGER,
      amount: D.DECIMAL,
      paid_on: D.DATEONLY,
      reference: D.STRING,
      note: D.TEXT,
      recorded_by_user_id: D.INTEGER,
      reverses_payment_id: D.INTEGER,
      request_key: D.UUID,
      created_at: D.DATE,
    },
  ],
  Notification: [
    "notifications",
    {
      user_id: D.INTEGER,
      title: D.STRING,
      body: D.TEXT,
      route: D.STRING,
      read_at: D.DATE,
      created_at: D.DATE,
    },
  ],
  User: [
    "users",
    {
      full_name: D.STRING,
      email: D.STRING,
      password_hash: D.TEXT,
      skills: D.JSONB,
      hourly_rate: D.DECIMAL,
      availability_status: D.STRING,
      platform_role: D.STRING,
    },
  ],
  Organization: [
    "organizations",
    {
      name: D.STRING,
      created_by_user_id: D.INTEGER,
      trade_focus: D.STRING,
      organization_types: D.JSONB,
    },
  ],
  OrganizationRole: [
    "organization_roles",
    {
      org_id: D.INTEGER,
      name: D.STRING,
      description: D.TEXT,
      skills: D.JSONB,
      hourly_rate: D.DECIMAL,
    },
  ],
  OrganizationMember: [
    "organization_members",
    {
      user_id: D.INTEGER,
      org_id: D.INTEGER,
      internal_role: D.STRING,
      company_role_id: D.INTEGER,
      hourly_rate: D.DECIMAL,
      joined_at: D.DATE,
    },
  ],
  JobPosting: [
    "job_postings",
    {
      posted_by_user_id: D.INTEGER,
      posted_by_org_id: D.INTEGER,
      company_role_id: D.INTEGER,
      hourly_rate: D.DECIMAL,
      title: D.STRING,
      description: D.TEXT,
      status: D.STRING,
    },
  ],
  JobApplication: [
    "job_applications",
    {
      job_posting_id: D.INTEGER,
      applicant_user_id: D.INTEGER,
      desired_rate: D.DECIMAL,
      offered_rate: D.DECIMAL,
      revision: D.INTEGER,
      negotiation: D.JSONB,
      status: D.STRING,
      submitted_at: D.DATE,
    },
  ],
  Project: [
    "projects",
    {
      client_user_id: D.INTEGER,
      title: D.STRING,
      description: D.TEXT,
      status: D.STRING,
      posted_at: D.DATE,
    },
  ],
  ProjectSubdivision: [
    "project_subdivisions",
    {
      planned_start: D.DATEONLY,
      duration_days: D.INTEGER,
      predecessor_id: D.INTEGER,
      schedule_version: D.INTEGER,
      project_id: D.INTEGER,
      parent_subdivision_id: D.INTEGER,
      awarded_user_id: D.INTEGER,
      awarded_org_id: D.INTEGER,
      scope: D.TEXT,
      sequence: D.INTEGER,
      status: D.STRING,
      required_credentials: D.JSONB,
    },
  ],
  Bid: [
    "bids",
    {
      subdivision_id: D.INTEGER,
      bidding_user_id: D.INTEGER,
      bidding_org_id: D.INTEGER,
      amount: D.DECIMAL,
      status: D.STRING,
    },
  ],
  InventoryItem: [
    "inventory_items",
    {
      owner_user_id: D.INTEGER,
      owner_org_id: D.INTEGER,
      item_name: D.STRING,
      stock: D.INTEGER,
      unit: D.STRING,
      unit_cost: D.DECIMAL,
    },
  ],
  ProjectInventory: [
    "project_inventory",
    {
      subdivision_id: D.INTEGER,
      item_id: D.INTEGER,
      qty: D.INTEGER,
      unit_cost: D.DECIMAL,
      consumed_at: D.DATE,
    },
  ],
  InventoryMovement: [
    "inventory_movements",
    {
      item_id: D.INTEGER,
      actor_user_id: D.INTEGER,
      quantity: D.INTEGER,
      reason: D.STRING,
      project_inventory_id: D.INTEGER,
      created_at: D.DATE,
    },
  ],
  Timesheet: [
    "timesheets",
    {
      user_id: D.INTEGER,
      subdivision_id: D.INTEGER,
      org_id: D.INTEGER,
      hours: D.DECIMAL,
      start_time: D.TIME,
      end_time: D.TIME,
      date: D.DATEONLY,
      note: D.STRING,
      hourly_rate: D.DECIMAL,
    },
  ],
};
function withNoVerifySsl(url) {
  // Managed Postgres providers (Supabase, etc.) often include
  // sslmode=require in their connection string. Newer pg versions treat
  // require/prefer/verify-ca as aliases for verify-full, which performs
  // strict certificate chain validation and overrides an explicit
  // rejectUnauthorized: false. Force no-verify so the intended "encrypted,
  // don't verify the chain" behavior actually takes effect.
  const parsed = new URL(url);
  parsed.searchParams.set("sslmode", "no-verify");
  return parsed.toString();
}
function createDatabase(url, options = {}) {
  if (!url) throw new Error("DATABASE_URL is required");
  const connectionUri = options.ssl ? withNoVerifySsl(url) : url;
  const db = new Sequelize(connectionUri, {
    dialect: "postgres",
    logging: false,
    pool: options.pool || { max: 5, min: 0, idle: 10000 },
    dialectOptions: options.ssl
      ? { ssl: { require: true, rejectUnauthorized: false } }
      : undefined,
  });
  const models = {};
  for (const [name, [tableName, fields]] of Object.entries(definitions)) {
    class Entity extends Model {}
    Entity.init(
      {
        id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
        ...fields,
      },
      { sequelize: db, modelName: name, tableName, timestamps: false },
    );
    models[name] = Entity;
  }
  const relation = (child, parent, key, as) => {
    models[child].belongsTo(models[parent], { foreignKey: key, as });
    models[parent].hasMany(models[child], {
      foreignKey: key,
      as: `${child}_${key}`,
    });
  };
  for (const args of [
    ["Organization", "User", "created_by_user_id", "creator"],
    ["OrganizationMember", "User", "user_id", "user"],
    ["OrganizationRole", "Organization", "org_id", "organization"],
    [
      "OrganizationMember",
      "OrganizationRole",
      "company_role_id",
      "companyRole",
    ],
    ["JobPosting", "OrganizationRole", "company_role_id", "companyRole"],
    ["OrganizationMember", "Organization", "org_id", "organization"],
    ["JobPosting", "User", "posted_by_user_id", "poster"],
    ["JobPosting", "Organization", "posted_by_org_id", "organization"],
    ["JobApplication", "JobPosting", "job_posting_id", "posting"],
    ["JobApplication", "User", "applicant_user_id", "applicant"],
    ["Project", "User", "client_user_id", "client"],
    ["ProjectSubdivision", "Project", "project_id", "project"],
    ["ProjectSubdivision", "User", "awarded_user_id", "awardedUser"],
    [
      "ProjectSubdivision",
      "Organization",
      "awarded_org_id",
      "awardedOrganization",
    ],
    ["Bid", "ProjectSubdivision", "subdivision_id", "subdivision"],
    ["Bid", "User", "bidding_user_id", "user"],
    ["Bid", "Organization", "bidding_org_id", "organization"],
    ["InventoryItem", "User", "owner_user_id", "user"],
    ["InventoryItem", "Organization", "owner_org_id", "organization"],
    ["ProjectInventory", "ProjectSubdivision", "subdivision_id", "subdivision"],
    ["ProjectInventory", "InventoryItem", "item_id", "item"],
    ["Timesheet", "User", "user_id", "user"],
    ["Timesheet", "Organization", "org_id", "organization"],
    ["Timesheet", "ProjectSubdivision", "subdivision_id", "subdivision"],
    ["InventoryMovement", "InventoryItem", "item_id", "item"],
    ["InventoryMovement", "User", "actor_user_id", "actor"],
    [
      "InventoryMovement",
      "ProjectInventory",
      "project_inventory_id",
      "consumption",
    ],
  ])
    relation(...args);
  models.OrganizationMember.prototype.canManage = function () {
    return ["owner", "manager"].includes(this.internal_role);
  };
  models.Timesheet.prototype.isOnBehalfOfOrg = function () {
    return this.org_id !== null;
  };
  models.User.prototype.toJSON = function () {
    const value = { ...this.get() };
    delete value.password_hash;
    return value;
  };
  return { db, models };
}
async function migrate(db) {
  await db.transaction(async (transaction) => {
    await db.query("SELECT pg_advisory_xact_lock(82167431)", { transaction });
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      { transaction },
    );
    const [rows] = await db.query("SELECT name FROM schema_migrations", {
      transaction,
    });
    for (const name of (await fs.readdir(path.join(__dirname, "migrations")))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (rows.some((r) => r.name === name)) continue;
      await db.query(
        await fs.readFile(path.join(__dirname, "migrations", name), "utf8"),
        { transaction },
      );
      await db.query("INSERT INTO schema_migrations(name) VALUES ($1)", {
        bind: [name],
        transaction,
      });
    }
  });
}
module.exports = { createDatabase, migrate, withNoVerifySsl };
