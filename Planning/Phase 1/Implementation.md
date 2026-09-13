# Phase 1 implementation

The supplied **WorkOrder Redesign.html** and **WorkOrder Market Readiness.html** are the design and sequencing references. Their sample names, figures, badges, and proposed features are not seeded into the application.

## Increment 1 — commercial records and the Industry interface

Implemented:

- Industry visual system across the web console: technical grid ground, steel accent, hairline panels, compact navigation, condensed headings and locally hosted Barlow fonts extracted from the supplied redesign. Responsive and print states are included.
- Work-aware overview actions based on client projects and active assignments.
- Billing navigation and per-scope workspace. Project summaries distinguish direct contracts from nested subcontracts, preventing contract values from being counted twice.
- Change proposals with description, signed price delta and schedule-day delta. Only the other contracting party can accept/reject; the proposing party can withdraw. Actor, date and decision note remain on the record. Only accepted proposals amend the price. Schedule deltas are recorded but do not yet drive dependencies.
- Progress applications prepared from saved timesheet rates and consumed-material costs through the period end, with a separate declaration of still-stored materials. Review precedes submission. Changed source records invalidate an earlier preview.
- Application source snapshots, counterparty approval/rejection, contractor withdrawal, sequential approved periods and cumulative retainage. A submitted application must be resolved before another is created. Completed scopes can request release of retainage at zero percent.
- Partial external-payment records with references, retry keys and a server-enforced unpaid-balance limit. Corrections append reversals; the database rejects payment edits/deletions. These records neither transfer funds nor independently confirm receipt at a bank.
- Printable applications (browser Print / Save PDF), CSV exports, source detail and inbox notifications.
- Migration `006-scope-billing.sql`, transactional authorization and concurrency tests, and an end-to-end browser workflow.

### Calculation contract

Billing is currently **USD only**. Existing accepted bid amounts are interpreted as USD in this first billing release; multi-currency negotiation is not implemented.

```
amended price = accepted award + accepted change-order deltas
gross earned = costed hours + consumed materials + declared still-stored materials
retainage = gross earned × retainage percentage, rounded to cents
net earned = gross earned − retainage
new application = net earned − previously approved application amounts
unpaid certified = approved application amounts − net recorded external payments
```

Prior **approved amounts**, rather than only payments, are deducted from new applications. An unpaid prior application is not billed again. Existing unpaid balances remain visible separately. Retainage is cumulative, not added afresh for every period. All backend money arithmetic uses integer cents; each labor entry is rounded as in existing cost reports.

This is a **recorded-cost billing basis**, capped at the amended price. It does not yet implement a schedule of values, fixed-price percentage-complete billing, markup, tax, invoices, statutory pay forms or retainage agreements/signatures. Stored material declarations are reviewed by the payer, not independently verified or reserved in inventory. Material cutoff dates use UTC. Later time corrections do not rewrite submitted snapshots; a subsequent application reconciles current cumulative cost. If corrections produce no positive new amount, the application is blocked; credit applications are a future increment.

### Contract-chain authority

For root work, the project client pays the awarded contractor. For a child scope, the immediate parent's awarded contractor is the payer (its owner/managers act for an organization). An unawarded parent falls back to the project client. A project client can inspect subcontract records but cannot approve them on behalf of the immediate payer. Ordinary crew members cannot inspect or decide commercial records. Completed scopes remain accessible for billing closeout.

## Increment 2 — Stripe Connect funding and controlled payouts

**User decision:** use Stripe Connect, with manual payouts rather than in-house escrow.

The repository contains the Connect adapter, funding migration and ledger, hosted onboarding, Checkout funding, approval-controlled transfers, manual payouts, signed webhooks, refunds, dispute holds and Billing interface. The interrupted time-entry changes had removed the API wiring; that wiring is now restored, including the raw webhook route before JSON parsing. External payment annotations remain separate and reduce the certified balance available for release.

Automated funding tests use a deterministic provider with Stripe-signed webhook payloads. They cover authorization, asynchronous funding, duplicate/out-of-order events, concurrent releases, retries, refunds, disputes, waiver gates, and payout outcomes. They do not establish that a real Stripe test account has completed onboarding, collection and bank payout.

The user confirmed US / USD and Express connected accounts. The integration uses separate charges and transfers; live keys remain disabled by default. A real Stripe sandbox walkthrough remains outstanding; the local environment does not have Stripe keys or APP_URL configured. Settlement now persists the resolution and its required evidence packet atomically, fixing a database constraint failure found by the existing dispute tests.

Payout aging now reads the complete recorded release/payout history and attributes paid bank payouts to the oldest eligible releases. Partial payouts preserve the original deadline of remaining funds; pending, failed and canceled payouts do not clear it. A payout returned by the bank after being reported paid restores the unpaid amount. Excess payouts never clear future releases, and reversals of already-paid funds are flagged for reconciliation. The Billing administration view lists remaining amounts and country-specific deadlines, including due-soon and overdue funds.

This is conservative attribution from WorkOrder records, not a reconciliation of every Stripe balance transaction. Fees, activity performed directly in Stripe, and ambiguous reversal timing still require reconciliation. It does not automatically pay out or enforce holding deadlines. Country holding periods follow [Stripe's manual payout documentation](https://docs.stripe.com/connect/manual-payouts), rechecked for this change.

Implementation sequence:

1. Confirm launch country, settlement currency and Connect account configuration. Create hosted onboarding for each contractor user or organization. Store the account ID on the actual contracting entity. Recheck payout capabilities and onboarding requirements from Stripe.
2. Implement test-mode collection against an awarded scope with an explicit funding allocation, PaymentIntent/Checkout IDs, captured/available/refunded amounts and currency. Keep authorization, capture, availability and payout distinct. Choose the charge/transfer model explicitly; one parent contract may have separately funded subcontracts.
3. Configure connected-account payout schedules to manual. Track each business's holding deadline and surface upcoming deadlines to administrators. Manual payouts alone do not segregate one scope from another in a connected account's pooled balance.
4. Add a durable per-scope allocation/release ledger. A release requires the appropriate approval/completion milestone, available allocated funds, no scope hold and no prior use of those funds. Retainage remains allocated until closeout. Prevent both over-release and double payment when external payments have already settled an application.
5. Build idempotent provider requests plus signed, deduplicated webhook ingestion (raw body before JSON middleware), retries, reconciliation and refund/chargeback handling. A return from Checkout is not proof of payment. Track requested, processing, failed and paid events separately.
6. Test onboarding, successful/asynchronous/failed funding, duplicate and out-of-order webhooks, concurrent releases, bank payout failures, refunds, disputes, and retainage closeout. Keep live mode off until the full test flow is reviewable.

Stripe's current documentation (checked September 13, 2026): [manual payouts](https://docs.stripe.com/connect/manual-payouts) and [separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers). Manual payout holding periods currently depend on country: US two years, Thailand ten days, other countries ninety days. The Payouts API moves connected-account balance to an external account; charge/transfer routing is a separate concern. Stripe does not provide escrow accounts. Product language should say **funded**, **awaiting release**, **payout processing** and **paid**, backed by the corresponding provider records.

## Integrated time entry

Time & reports includes an inline assignment form for up to 31 dated start/end intervals per submission, with an explicit hours-only option when clock times are unknown. Project and overview shortcuts open this workspace. The server saves the batch atomically, snapshots the applicable pay rate, attributes organization work automatically, and checks combined daily hours across all assignments under a user lock. Failed batches preserve entered values; successful batches refresh the grid, totals and entries. Migration `010-timesheet-clock-times.sql` preserves nullable clock times, with database validation that the derived duration matches hours. The grid positions and sizes blocks from saved times, opens near the first recorded start, and places overlapping entries in separate columns. Legacy hours-only entries are listed separately rather than assigned a fictitious midnight start. Editing can add clock times to legacy entries or correct existing intervals. Times are wall-clock values on the entered work date; an end time of 00:00 means the end of that day. Overnight work uses separate rows for each date. Payroll hours remain rounded to hundredths, while grid placement uses the exact entered minutes.

## Remaining roadmap

| Objective                        | Current state                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Scope funding / release ledger   | Connect implemented and reconnected; real sandbox verification pending           |
| Progress billing / retainage     | Cost-based records implemented; Stripe settlement and fixed-price billing remain |
| Change orders                    | Price and schedule deltas, acceptance and history implemented                    |
| Lien waivers                     | Implemented; signature and payment-state tests pass                              |
| License / insurance verification | Implemented; credential model restored and tests pass                            |
| Completed-work reputation        | Implemented; completed-scope review tests pass                                   |
| Disputes / evidence packets      | Implemented; settlement and evidence-packet tests pass                           |
| Offline crew time clock          | Not implemented; existing interactive time grid retained                         |
| Photo daily reports              | Not implemented                                                                  |
| Documents / signatures           | Application print/export only; document storage and signatures remain            |
| Dependency schedule              | Change-day deltas only; scheduling remains                                       |
| Purchase orders / reservations   | Not implemented                                                                  |
| Permanent inventory ledger       | Existing inventory movement retained; costing/period-close work remains          |
| Accounting / payroll / delivery  | Application CSV only; integrations and delivery remain                           |

The first increment is not the complete market-readiness release. The next proof point remains an awarded scope funded and paid through Stripe in test mode, with all transitions reconciled.
