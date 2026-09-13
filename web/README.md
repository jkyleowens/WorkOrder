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

| Area | Supported actions |
| --- | --- |
| Account | Register, sign in, sign out, restore the session after refresh; edit name, skills, hourly rate, and availability |
| Context selector | Switch between personal, client, and organizations where you are an owner or manager |
| Overview | Read current hours, assignments, inventory counts, client projects, and pending offers |
| Projects | Browse the market, post projects with optional subdivisions, review client projects and assignments, edit unbid scopes, cancel unawarded projects |
| Bidding | Bid as yourself or an organization, review/withdraw bids, award a bidder per subdivision |
| Execution | Start/complete subdivisions; log time and consume personal or matching organization materials; inspect labor and material costs |
| Employment | Browse jobs, post personal or organization roles, apply, make/reject offers, accept/withdraw applications, close postings, review hiring history |
| Organizations | Create an organization, view its roster and shared inventory, change non-owner member roles as the owner |
| Time & reports | Personal daily grid, date-range totals and individual entries; edit/delete eligible entries; organization hours and costs grouped by worker and subdivision |
| Inventory | Add items, receive stock and update future unit costs, consume stock on assigned work, inspect movement history |
| People & skills | Browse public profiles, skills, availability, and rates |

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
