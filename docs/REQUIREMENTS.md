# Requirement Coverage

This document maps the implementation to the Ent-JFE-20/05/26 requirements.

## Backend

| Requirement | Implementation |
|---|---|
| Event store schema | `EventLog` stores aggregate ID, type, JSON payload, integer version, UTC timestamp, and unique idempotency key. |
| Double-entry ledger | `LedgerEntry` stores order, account, debit or credit, event link, and timestamp. A PostgreSQL check constraint enforces exactly one side per row. |
| Decimal precision | Monetary values use PostgreSQL `DECIMAL(18,4)` and service-side `Decimal.js`; API amounts are decimal strings. |
| Idempotency | Mutations check unique event or settlement idempotency keys before writing. Duplicate requests return the existing result. |
| Version conflicts | Order updates use `updateMany` with `{ id, version }`. A zero-row update returns `VersionConflictError`. |
| State machine | `PENDING -> PAYMENT_PROCESSING -> PAID -> FEE_CALCULATED -> SHIPPED -> DELIVERED`; refund is allowed from `PAID` and `FEE_CALCULATED`. |
| Payment processing | `PaymentService` moves orders to processing, calls a retry-safe Stripe mock, confirms payment, and reverts to pending on card decline. |
| Fee calculation | `calculateFees` applies a 3% fee with Decimal arithmetic and creates balanced fee ledger entries. |
| Refunds | `processRefund` reverses payment ledger entries and, when needed, creates a second fee-reversal event while keeping order version aligned. |
| Daily settlement | `dailySettlement` processes delivered orders in the requested date window, skips orders already settled, writes payout ledger entries, and stores a settlement record. |
| Ledger verification | `GET /api/verify-ledger/:id` returns total debits, total credits, entries, and balanced status. |
| API routes | Orders, payment, fees, refund, fulfillment, ledger, settlement, settlement history, and health routes are registered in Fastify. |
| Concurrency | Serializable transactions, optimistic locking, unique idempotency keys, and unique aggregate/version indexes protect concurrent writes. |
| Tests | Jest covers happy path, idempotency, ledger balance, precision, concurrent service behavior, settlement idempotency, version conflict, invalid transitions, projection consistency, refunds, and payment failure recovery. |
| Live stress check | `npm run stress:orders` sends 1,000 order-create requests through the HTTP API and samples ledger verification against the configured database. |

## Frontend

| Requirement | Implementation |
|---|---|
| Order status card | Shows amount, payment received, fees, net amount, payment method, created date, status, and version. Provides valid next actions. |
| Ledger audit trail | Shows timestamp, account, debit, credit, description, and running balance. Running balance uses scaled integer string arithmetic. |
| Seller dashboard | Shows order table, statistics, recent activity, create-order flow, detail pages, and settlement workspace. |
| Live updates | Orders and ledgers refresh on polling intervals, with explicit refetch after user actions. |
| Mobile-first Tailwind | Layouts use responsive Tailwind grids, spacing, and mobile navigation. |
| TypeScript strict | Frontend `tsconfig.json` enables strict mode. |

## Documentation

- Architecture: `docs/ARCHITECTURE.md`
- Concurrency strategy: `docs/CONCURRENCY.md`
- Financial rules: `docs/FINANCIAL_RULES.md`
- Full project explanation: `docs/PROJECT_EXPLANATION.md`
