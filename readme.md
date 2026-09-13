# WorkOrder

The database-backed application now includes registration/login and a user console for personal work, client projects, and organization management. See the [console guide](web/README.md) and [database setup/API reference](backend/README.md).

To run the connected application, configure PostgreSQL and `.env` using the backend guide, run `npm run web`, then open **http://127.0.0.1:3000/register**. The frontend and API share one server and session. Use `npm run test:console` for real-browser PostgreSQL integration tests, and `npm test` for the backend/storage suite.

The original desktop prototype documented below remains available separately through `npm start` or `npm run dev`. It does not use the connected application's accounts or database.

## Original desktop prototype

A local-first desktop workspace built with Node.js, Electron, and a lightweight HTML/CSS/JavaScript renderer.

## Run

Install **Node.js 22.12 or newer**, then:

```sh
npm install
npm start
```

For a browser preview, run `npm run dev` and open http://127.0.0.1:5173.

## Included in this foundation

- Overview with live project, inventory, time, and team totals, restock alerts, and recent activity.
- Projects with owners, due dates, categories, status filters, search, and editable task checklists. Completing a project completes its checklist; reopening a task reopens the project.
- Inventory with unique SKUs, categories, locations, quantities, units, unit costs, minimum stock thresholds, search, and stock receipts/usage with a reason. Stock cannot become negative.
- Employee profiles with position, hire date, email, and manually maintained contribution counts; search and sorting by name, position, hire date, or contributions.
- One persistent focus timer, project-linked session history, and manual time entry. A running timer includes elapsed time while the app is closed.
- Workspace JSON export in workspace settings.

The first launch creates editable sample records. Desktop data lives in `workspace.json` inside Electron’s platform-specific user data directory (`app.getPath('userData')`). Writes use a temporary file and rename, and are serialized. The browser preview uses localStorage and has a separate dataset. No account or network service is needed.

## Development

- `electron/main.cjs`: desktop lifecycle and restricted persistence IPC.
- `electron/preload.cjs`: isolated renderer bridge exposing only read/save.
- `electron/store.cjs`: persistence payload validation.
- `src/app.js`: sample state, views, and workflows.
- `src/styles.css`: desktop layout with smaller-window adaptations.
- `server.cjs`: local preview server exposing only renderer assets.

Electron uses a sandboxed renderer, context isolation, no Node integration, a restrictive content security policy, and blocks new windows and navigation. Architecture follows the [Electron context isolation guidance](https://www.electronjs.org/docs/latest/tutorial/context-isolation).

## Verification

```sh
npm test
npx playwright install chromium
npm run test:ui
```

To use an existing Chromium installation:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:ui
```

UI tests cover project/checklist persistence, stock validation and persistence, employee sorting, and timer recovery.

## Current scope

This is a single-device foundation, not a shared team server. It does not yet include authentication, cloud synchronization, purchase orders, material reservations, a permanent stock ledger, backup import, or distributable installers. Recent activity retains the latest 60 events. Inventory value is a simple quantity × unit cost total. Exports are full JSON snapshots; keep copies of the desktop data file before manual migration.
