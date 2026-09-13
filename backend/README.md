# WorkOrder backend

This implements phases 1–3 of `Planning/Overview.md` and the service/model flows in `Planning/WorkOrder_Diagrams.html`. The existing Electron/localStorage prototype remains separate. It is not connected to this API, and its sample data is not migrated. The EJS user console now uses this API; see [frontend workflows and browser tests](../web/README.md).

## Run

Use Node.js 22.12+ and PostgreSQL 18. From the repository root:

```sh
npm install
cp .env.example .env
# Set SESSION_SECRET in .env to a random value, for example generated with:
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
docker compose up -d database
npm run db:migrate
npm run api
```

The user console opens at `http://127.0.0.1:3000/register`, and the API listens at `http://127.0.0.1:3000/api`. `GET /api/health` verifies database connectivity. Startup also applies pending migrations. Configuration is read from `.env` by Node; `.env` is ignored by Git. The Compose credentials are for local development.

For deployment, supply a managed PostgreSQL URL and a strong session secret, use HTTPS, and set `NODE_ENV=production` so session cookies require HTTPS. The application does not trust forwarded headers by default. A TLS-terminating proxy requires an explicitly configured `trust proxy` policy in `createApp` appropriate to the deployment; do not enable unrestricted proxy trust. The login/register limiter currently uses a process-local store; multi-instance deployments need a shared limiter. Email verification, password recovery, notification delivery, payments, and payroll exports are not specified in phases 1–3 and are not implemented.

## Architecture

- `database.cjs` creates Sequelize model classes and bidirectional associations for User, Organization, OrganizationMember, JobPosting, JobApplication, Project, ProjectSubdivision, Bid, InventoryItem, ProjectInventory, and Timesheet. InventoryMovement provides an append-only stock ledger through the service API. Model serialization excludes password hashes.
- `migrations/*.sql` is the authoritative PostgreSQL schema: foreign keys, monetary precision, state checks, exclusive user/org ownership, unique memberships/applications/bids, and reporting indexes. `migrate` records applied files under an advisory transaction lock. It never calls `sync({alter:true})` or drops data. Apply new forward migrations for future changes; take backups before production schema upgrades.
- `services.cjs` contains `PlatformService`, the domain boundary for identity, organization permissions, employment, bidding, execution, inventory, and reports. Mutations parse strict schemas and use authenticated actor IDs supplied by the server. The convenience operations depicted on models in the planning diagrams live here so authorization and transactions cannot be bypassed by a model helper.
- `validation.cjs` defines request contracts and domain errors.
- `app.cjs` exposes Express JSON routes, PostgreSQL-backed sessions, CSRF protection, security headers, auth throttling, bounded request bodies, and centralized errors.
- `start.cjs` handles configuration, migrations, startup, and graceful shutdown.

Sequelize managed transactions roll back multi-step operations on failure. Award and resource operations lock project → subdivision, then the affected item or user. User locks serialize daily totals across subdivisions; inventory locks prevent overspending stock; project locks serialize competing awards and subdivision changes. Reports use a repeatable-read snapshot so their totals and grouped rows describe the same database state. This follows Sequelize's [transaction and locking documentation](https://sequelize.org/docs/v6/other-topics/transactions/). Session configuration follows the [Express session documentation](https://expressjs.com/en/resources/middleware/session/).

## Decisions that make the planning flows concrete

- Context is a session preference, never an authorization role. A single account may be client, solo worker, and organization manager. Every organization operation checks membership independently of the selected context. Revoked manager access resets stale organization context to personal on the next request.
- Organization creation atomically creates an owner membership. Owners can change existing non-owner roles; managers can hire and operate for the organization. New members join by applying, receiving an offer, and accepting it. A hiring manager cannot silently enroll another user. Acceptance is atomic and cannot create duplicate memberships. Personal job acceptance creates no organization.
- Posting a project creates one implicit subdivision unless scopes are supplied. Replacing scopes is allowed only before any bids exist. Both solo users and organizations bid on subdivisions through one endpoint. Clients cannot bid on their own work, including through organizations they belong to.
- Only the client awards bids. Exactly one pending bid wins; competing pending bids are rejected in the same transaction. A project becomes active on its first award and completed when all subdivisions are completed. A client may cancel an entirely unawarded project. Cancelling active work and reassigning an award need additional business rules and are intentionally disallowed.
- Awarded workers log their own time; organization members can log on the organization's awarded work. `org_id` is derived from the award. If supplied, it must match. Client-only access does not permit logging someone else's hours. Daily totals cannot exceed 24 hours. Authors can correct hours/date/note or delete an entry while its subdivision is executable. Completed work is closed to resource edits.
- Hours use two decimal places; stock quantities are whole units, matching the diagrams. Money uses PostgreSQL decimal values, returned as strings. Rates and material unit costs are copied onto entries so later rate changes do not rewrite history. Labor cost rounds each entry to two decimals before summing. No tax, currency conversion, or overtime is inferred.
- Personal inventory belongs to its user; corporate inventory belongs to one organization. Members can consume their awarded organization's stock; managers receive stock. Users may contribute their own supplies to their organization's work. Other organizations' stock cannot be consumed. Opening stock, receipts, and consumption create ledger movements atomically.
- Reporting dates are inclusive ISO dates. The personal week starts Monday. Material consumption timestamps use UTC date boundaries; the database/session timezone is configured to UTC. `from`/`to` ranges are limited to 366 days. Organization dashboards attribute costs to the awarded organization.

## Authentication contract

1. `GET /api/auth/csrf` creates an anonymous session and returns `{csrf_token}`. Retain the `workorder.sid` cookie.
2. `POST /api/auth/register` with `{full_name,email,password}`, or `POST /api/auth/login` with `{email,password}`. Include `X-CSRF-Token` on these and all other writes.
3. Authentication rotates the session ID and returns `{user,context,csrf_token}`. Use the new token for subsequent writes. Cookies are HttpOnly and SameSite=Strict. Passwords require at least 12 characters and at most 72 UTF-8 bytes, and are hashed with bcrypt cost 12.
4. `POST /api/auth/logout` destroys the stored session. Sessions expire after seven days. GET responses containing authenticated data are not cacheable.

All routes below require authentication. CSRF headers are required for POST, PUT, PATCH, and DELETE. IDs are positive integers. Unknown body fields are rejected on data-bearing operations. Empty action endpoints need no body. Errors return `{error}` and, for validation, `details`; statuses are 401 unauthenticated, 403 unauthorized/CSRF, 404 missing, 409 duplicate/state conflict, and 422 invalid input. Lists accept `limit` (1–100, default 50) and `offset` (default 0), unless documented as date-range reports.

## API reference

| Method and path (under `/api`)                                | Input / behavior                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET `/me`                                                     | Own profile and current context                                                                                        |
| PATCH `/me`                                                   | Any of `full_name`, `skills` (string array), `hourly_rate`, `availability_status` (`available`, `busy`, `unavailable`) |
| GET `/users`, `/users/:id`                                    | Public profiles; excludes email and credentials                                                                        |
| PUT `/context`                                                | `{mode: "personal" or "client"}` or `{mode:"organization",org_id}`; organization requires manager/owner                |
| POST `/organizations`                                         | `{name,trade_focus?}`; creates owner membership                                                                        |
| GET `/organizations`                                          | Own memberships with organizations                                                                                     |
| GET `/organizations/:id/members`                              | Members only                                                                                                           |
| PUT `/organizations/:id/members`                              | Owner only: `{user_id,internal_role:"manager" or "member"}`; updates existing member                                   |
| POST `/jobs`                                                  | `{title,description,org_id?}`; optional org requires manager                                                           |
| GET `/jobs`, `/jobs/:id`                                      | Open employment board / posting detail                                                                                 |
| POST `/jobs/:id/close`                                        | Poster or org manager; rejects outstanding applications/offers                                                         |
| POST `/jobs/:id/applications`                                 | Apply as authenticated user                                                                                            |
| GET `/jobs/:id/applications`                                  | Poster or org manager reviews applications                                                                             |
| GET `/applications`                                           | Own applications                                                                                                       |
| PATCH `/applications/:id`                                     | Poster/manager: `{status:"offered" or "rejected"}`                                                                     |
| POST `/applications/:id/accept`, `/applications/:id/withdraw` | Applicant response                                                                                                     |
| POST `/projects`                                              | `{title,description?,subdivisions?:[scope,...]}`; returns project with subdivisions                                    |
| GET `/projects`                                               | Open/active market projects                                                                                            |
| GET `/me/projects`                                            | All own client projects                                                                                                |
| GET `/projects/:id`                                           | Project and ordered subdivisions                                                                                       |
| PUT `/projects/:id/subdivisions`                              | Client: `{scopes:[scope,...]}`; replaces unbid scopes                                                                  |
| POST `/projects/:id/cancel`                                   | Client; unawarded project only                                                                                         |
| POST `/subdivisions/:id/bids`                                 | `{amount,org_id?}`; positive amount                                                                                    |
| GET `/subdivisions/:id/bids`                                  | Client reviews all competing bids                                                                                      |
| GET `/bids`                                                   | Own solo bids                                                                                                          |
| GET `/organizations/:id/bids`                                 | Organization bids; manager only                                                                                        |
| POST `/bids/:id/withdraw`                                     | Bidder or bidding org manager                                                                                          |
| POST `/bids/:id/award`                                        | Client; awards the bid's subdivision                                                                                   |
| GET `/me/assignments`                                         | Solo awards and awards to organizations the user belongs to                                                            |
| PATCH `/subdivisions/:id`                                     | Client or awarded solo worker/org manager: `{status:"active" or "completed"}`                                          |
| GET `/subdivisions/:id/costs`                                 | Client/awardee manager; `{labor_cost,material_cost}`                                                                   |
| POST `/inventory`                                             | `{item_name,stock,unit?,unit_cost?,org_id?}`; org manager or personal owner                                            |
| GET `/inventory`                                              | Own stock                                                                                                              |
| GET `/organizations/:id/inventory`                            | Organization stock; members only                                                                                       |
| POST `/inventory/:id/receipts`                                | Owner/manager: `{quantity,reason,unit_cost?}`                                                                          |
| GET `/inventory/:id/movements`                                | Owner/manager: stock ledger                                                                                            |
| POST `/subdivisions/:id/materials`                            | Awarded worker/member: `{item_id,qty}`                                                                                 |
| POST `/time`                                                  | `{subdivision_id,date,start_time,end_time,note?,org_id?}` or legacy `hours`; org inferred from award                                                   |
| PATCH `/time/:id`                                             | Author: `{start_time?,end_time?,hours?,date?,note?}`; clock edits derive hours; rate/assignment immutable                                                          |
| DELETE `/time/:id`                                            | Author; executable work only                                                                                           |
| GET `/time/entries?from=YYYY-MM-DD&to=YYYY-MM-DD`             | Own individual entries with IDs for editing                                                                            |
| GET `/time?from=...&to=...`                                   | Own hours, labor cost, and grouped date/subdivision entries                                                            |
| GET `/time/week?date=YYYY-MM-DD`                              | Own Monday–Sunday grid and totals                                                                                      |
| GET `/organizations/:id/time?from=...&to=...`                 | Manager: org hours/cost and rows grouped by user/date/subdivision                                                      |
| GET `/organizations/:id/dashboard?from=...&to=...`            | Manager: org time report plus material cost                                                                            |

The `sequelize → uuid` override pins CommonJS-compatible UUID 11.1.1 to address [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq). Sequelize uses the compatible `v1()`/`v4()` interfaces; integration tests exercise its transaction UUID generation. Reassess this override when upgrading Sequelize.

## Verification and requirement coverage

```sh
npm test               # existing storage tests plus backend tests
npm run test:backend   # backend only
```

Backend tests launch an isolated real PostgreSQL 18 instance using `embedded-postgres` and exercise Sequelize and HTTP via Supertest. They require localhost socket/process access and a non-root user, but no Docker, existing database, `.env`, or running application. Test data lives in a unique temporary directory and is removed afterward. The tests never connect to `DATABASE_URL` or a developer database.

| Planning requirement                        | Verification                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Universal account, profile, secure auth     | Password hashing, normalization, duplicates, private-field filtering, CSRF, session rotation/logout/restart/expiry |
| Organizations and permission-based contexts | Atomic owner membership, offer consent, role changes, member/outsider denial                                       |
| Employment market                           | Personal/org posting, apply, offer, accept, withdraw, reject on close, concurrent acceptance, rollback             |
| Project/subdivision market                  | Implicit subdivision, replacement guards, mixed awards, withdrawal/cancellation, completion                        |
| Bid ownership and exclusive awards          | Self-bid denial, owner permissions, concurrent awards, database checks                                             |
| Personal and org time                       | Award-derived organization, weekly roll-up, rate snapshots, corrections, concurrent daily caps                     |
| Personal and org inventory                  | Ownership denial, concurrent consumption, ledger balance, cost snapshots, transaction rollback                     |
| Database and API interactions               | Repeatable migrations, associations, direct SQL constraints, end-to-end HTTP day-in-the-life                       |

## Frontend read models

The console uses paginated `GET /api/me/jobs` for personal hiring history and `GET /api/organizations/:id/jobs` for organization hiring history (manager permission required). Both include closed postings. Job board rows include public poster/organization names; applications include posting or applicant details; bids include public bidder names and subdivision/project details; assignments include project and awarded organization details; roster rows include public user details. Nested public profiles exclude email and password hashes.

### Clock times and payout holding

`POST /api/time/bulk` accepts `{subdivision_id, entries}` with 1–31 entries. Each entry has a work date, optional note, and either `start_time` / `end_time` (`HH:mm`) or duration-only `hours`. A midnight end (`00:00` or `24:00`) means the end of the work date. Other end times must follow the start on that date; split overnight work into dated rows. Times are local wall-clock values, not timezone-aware timestamps. Saved hours are rounded to two decimals. Migration 010 leaves historical times null; no midnight starts are invented.

`GET /api/admin/payout-holding` requires a platform administrator and returns oldest-first release amounts, deadlines and reconciliation exceptions. Payment-account responses also include `aging`. This derives conservative FIFO attribution from complete WorkOrder payout history, including partial payments and bank returns. It does not replace reconciliation of Stripe fees, transfers and payouts performed outside WorkOrder, or automatically enforce deadlines.
