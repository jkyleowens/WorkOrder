# WorkOrder user console

The EJS entry page, vanilla JavaScript console, and Express API are served together. All records come from PostgreSQL through authenticated API requests. The console has no demo seed data or localStorage persistence.

## Start

Follow the database and `.env` setup in [the backend guide](../backend/README.md), then run:

```sh
npm run web
```

Open **http://127.0.0.1:3000/register** to create an account, or **/login** to sign in. Returning authenticated users open **/console**. The server applies database migrations at startup. `npm run api` serves the same complete application.

The original Electron prototype and its preview are separate; they do not use these accounts or database records.

## Console workflows

| Area             | Supported actions                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account          | Register, sign in, sign out, restore the session after refresh; edit name, skills, hourly rate, and availability                                            |
| Context selector | Switch between personal, client, and organizations where you are an owner or manager                                                                        |
| Overview         | Read current hours, assignments, inventory counts, client projects, and pending offers                                                                      |
| Projects         | Browse the market, post projects with optional subdivisions, review client projects and assignments, edit unbid scopes, cancel unawarded projects           |
| Bidding          | Bid as yourself or an organization, review/withdraw bids, award a bidder per subdivision                                                                    |
| Execution        | Start/complete subdivisions; log time and consume personal or matching organization materials; inspect labor and material costs                             |
| Employment       | Browse jobs, post personal or organization roles, apply, make/reject offers, accept/withdraw applications, close postings, review hiring history            |
| Organizations    | Create an organization, view its roster and shared inventory, change non-owner member roles as the owner                                                    |
| Time & reports   | Personal daily grid, date-range totals and individual entries; edit/delete eligible entries; organization hours and costs grouped by worker and subdivision |
| Inventory        | Add items, receive stock and update future unit costs, consume stock on assigned work, inspect movement history                                             |
| People & skills  | Browse public profiles, skills, availability, and rates                                                                                                     |

Employment acceptance is the membership entry path: an employer offers a role and the applicant accepts it. Ordinary members use personal context to record organization work; the award determines where it rolls up. Organization mode is reserved for managers and owners. All permissions are checked by the server even when the UI hides an unavailable action.

## Interaction behavior

- Forms retain their values when validation fails. Submissions are disabled while pending, and success messages appear only after the API confirms the write.
- Destructive and consequential actions have named confirmation dialogs. Dialogs use native keyboard focus handling, Escape dismissal, and focus restoration.
- Navigation and page refresh fetch authoritative data. There is no automatic polling or live push; users see other users' changes on their next navigation or refresh.
- Session cookies are HttpOnly. CSRF tokens stay in memory; writes include the token header. Expired authenticated reads return the user to login. A stale CSRF token is refreshed for the next attempt; failed writes are never automatically repeated.
- User-provided text is escaped. Templates do not embed credentials, session data, or inline scripts. Assets are same-origin and respect the backend's content security policy.
- Lists are paginated. Personal collections needed for selections and reporting are loaded across all API pages. Pending navigation responses cannot replace a newer view.
- Responsive styles support desktop and narrow mobile layouts, with reduced-motion support, semantic form labels, visible focus indicators, and a skip link.

## Files

- `views/index.ejs`: server-rendered document and loading state.
- `public/api.js`: session-aware API client and pagination helper.
- `public/app.js`: login/register forms, console shell, context switching, navigation, and request lifecycle.
- `public/pages.js`: data-driven console screens.
- `public/actions.js`: forms, confirmations, and API mutations.
- `public/ui.js`: escaped HTML helpers, dialogs, status indicators, and notifications.
- `public/styles.css`: responsive visual design.

## Browser tests

```sh
npx playwright install chromium
npm run test:console
# Or use an installed browser:
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:console
```

The suite launches the actual application and an isolated PostgreSQL instance, then drives real browser interactions. It never uses the configured application database. Test credentials and data are temporary. Local socket access and a non-root user are required by embedded PostgreSQL.

The tests cover authentication and profile persistence, a three-account hiring/bidding/execution workflow, organization and client cost visibility, mobile layout, and escaped user content. Screenshots and failure traces are written to `test-results/`.

The console now uses one workspace without a context switcher. Choose the acting
organization inside bidding and hiring forms. Organization pages provide direct
links to their inventory, assignments, bids, hiring and reports. Owners and
managers (the existing administrative role) can edit organization details; roster
role changes remain owner-only. The legacy context API remains compatible with
older clients but no longer controls the web console.

Projects display a numbered work breakdown with nested scopes, contractor names
and completion progress. Clients can add child scopes; awarded contractors and
organization managers can subcontract their own active scopes. The immediate
parent contractor or project client reviews and awards child bids. Children can
be subcontracted again, and every child must finish before its parent can finish.
Costs remain recorded against the individual work package where they occur.
Migration `003-nested-work.sql` adds the parent relationship without changing
existing work. The Vercel entry point applies migrations during startup.

## Hourly pay and company roles

Company roles contain a name, responsibilities, required skills and base hourly
pay. Owners and managers can create/edit roles and assign a role and individual
pay to a member. These job roles are separate from owner/manager/member access.
An individual pay amount (including zero) overrides the role's base pay. Clearing
it uses role pay; members without either use their profile rate.

Job forms require advertised hourly pay and optionally start from a company role.
Applicants request pay and can send new requests after an offer. Employers offer
or revise a rate; every request/offer records its message in the pay discussion.
A counterproposal invalidates the previous offer. Rated offers require acceptance
of the reviewed revision, preventing acceptance of changed terms. Acceptance into
an organization assigns the posting's role and saves the agreed individual pay.
Editing the role's base rate does not override an individual's agreement.

New timesheets snapshot the effective organization rate, or the profile rate for
independent assignments. Rate changes apply when new entries are recorded,
including newly entered backdated hours. Editing an existing entry preserves its
saved rate. Company reports and project scope details show hours, saved rates and
labor cost per worker; project totals count each scope once. Bid amounts remain
separate from actual hourly labor costs. Existing unpriced jobs remain compatible
with older clients; migration `004-pay-and-company-roles.sql` preserves all saved
timesheet rates.

## Organization types and inbox

Organizations can select any combination of Contractor, Supplier, Labor union,
Client / developer, Consultant, and Other during creation or in organization
settings. These describe the organization and appear on its cards and profile;
they do not change owner/manager/member permissions or company job roles.
Existing organizations start without a selected type.

The Inbox stores notifications for new applications, pay requests, application
offers and responses, new project/subcontract bids, and awarded bids. Organization
owners and managers receive relevant hiring and bid notifications. Users can
filter unread activity, open the relevant work, mark individual notifications as
read, or mark all as read. Read state persists across sessions. Counts refresh
when navigating or refreshing; this is an activity inbox, without direct-message
composition or live push. Notifications begin with new activity after migration.
Migration `005-organization-types-inbox.sql` is applied at server startup.

## Phase 1 commercial workspace

The Industry redesign and Billing navigation are now part of the web console.
Open an awarded scope's **Scope billing & changes** link to propose amendments,
prepare/review progress applications, approve them as the paying party, or record
external payments. The Billing page lists authorized direct and subcontract work.

Applications retain their source records, period, saved costs, retainage and
approval history. Open an application to print/save a PDF or export a CSV.
Payments are annotations of transactions made elsewhere, with partial payment,
references and append-only corrections. They do not hold funds or trigger a bank
transfer. Stripe Connect with manual payouts is the selected next integration.

See [the implementation record](../Planning/Phase%201/Implementation.md) for
calculation rules, supported scope, Stripe integration sequence and remaining
roadmap items. See [the design system](DESIGN_SYSTEM.md) for reusable components.
Migration `006-scope-billing.sql` is applied by the normal startup migration flow.

### Trust and verification

Use **Trust & verification** to submit credentials for yourself or an organization you manage. Administrators see a **Verification queue** link there. Project commissioners set **Required credentials** on open scopes; bidder profiles display expiry and verification information. People and organization cards link to dated completed-work reputation.

Open **Billing → a scope → Reviews & disputes** to rate completed work or open a dispute, attach evidence, propose a split, respond, or download a dated JSON packet. Resolving a dispute records its agreed release/refund split; Billing shows subsequent payment processing. Credential review is manual, and pending credentials are identified as unverified.

### Field work — Release Three

**Field work** in the sidebar opens `/field`, a phone-friendly workspace with a time clock, daily reports, documents and a dependency schedule. Open it online once on each device to prepare the offline shell and save assignments. Billing also links directly to a scope's field reports.

- Time can be recorded for yourself, or for an awarded organization's crew by its owner/manager. A running clock survives reloads. Clock-out splits overnight work across local dates; completed intervals can also be entered directly. Queued time is stored separately for each signed-in account on the device and syncs when the page regains connectivity or **Sync time** is pressed. Each batch is atomic and has a stable retry key. Overlapping or hours-only existing entries, closed assignments, and changed permissions leave the batch queued for correction; retries do not duplicate saved hours. Pay rates are captured at server sync, using the existing effective-rate rules. Keep the browser's site data until all time is synced. Sync requires the original account and an open page; this does not use background sync while the app is closed.
- Reports record dated progress, headcount, weather, deliveries, delays and up to 12 photos (4 MB each). Crew and commissioning parties up the scope chain can review them. Reports are append-only; a later report records a correction. Report photos and metadata join dispute evidence packets.
- Each new award generates an agreement from its scope, parties and accepted bid. Existing awards receive the agreement on first opening Documents. Project and scope documents have immutable versions, attachments, content fingerprints and view/signature events. Authorized parties sign the exact version; new versions need fresh signatures. Scope instructions are visible to crew; private agreements and waivers follow commercial access rules. These are recorded in-app acknowledgements, with browser Print / Save PDF, rather than an external signature-provider integration.
- Schedules use calendar days, an earliest start, duration and one finish-to-start predecessor per scope. Moving a predecessor recalculates its dependent dates. Cycles, cross-project dependencies and stale edits are rejected. The field view shows project dates, scope dates and a rolling seven-day filter for assigned work. Saved schedules remain readable offline. Schedule edits, reports, uploads and signatures require connectivity.

The isolated checks for this release are `node --test tests/backend/field.test.cjs` and `npm run test:console -- tests/console/field.spec.cjs`. They cover only the new or changed field workflows.
