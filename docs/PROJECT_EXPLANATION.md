# Project Explanation

## Purpose

Entropi is a financial order-processing system for a seller that receives many daily orders. The system records orders immutably, processes mocked Stripe payments, calculates a 3% platform fee, prevents duplicate financial actions, supports refunds, performs daily settlement, and keeps a double-entry ledger that can be audited at any time.

The core principle is that operational state and financial history are separated:

- The `Order` table is the current read model for fast UI/API reads.
- The `EventLog` table is the append-only history of what happened.
- The `LedgerEntry` table is the accounting journal showing the money impact of each financial event.

## Main User Flow

1. Seller creates an order with amount, customer, and payment method.
2. Backend records `ORDER_CREATED`.
3. Backend creates two ledger entries:
   - Debit `ORDER_BALANCE`
   - Credit `ORDER_PENDING`
4. Seller processes payment.
5. Backend moves order to `PAYMENT_PROCESSING`, calls Stripe mock, then records `PAYMENT_CONFIRMED`.
6. Backend creates two payment ledger entries:
   - Debit `PAYMENT_RECEIVED`
   - Credit `ORDER_BALANCE`
7. Backend calculates the 3% fee and records `FEE_CALCULATED`.
8. Backend creates two fee ledger entries:
   - Debit `FEES_OWED`
   - Credit `PAYMENT_RECEIVED`
9. Seller marks the order as shipped and delivered.
10. Daily settlement processes delivered orders, creates payout ledger entries, and stores settlement totals.

## Backend Architecture

The backend is a Fastify API written in TypeScript. It uses Prisma to access PostgreSQL and Decimal.js for exact monetary calculations.

### Route Layer

Routes validate request shape and call services:

- `POST /api/orders`
- `GET /api/orders`
- `GET /api/orders/:id`
- `POST /api/orders/:id/pay`
- `POST /api/orders/:id/fees`
- `POST /api/orders/:id/refund`
- `POST /api/orders/:id/ship`
- `POST /api/orders/:id/deliver`
- `GET /api/orders/:id/ledger`
- `POST /api/settle`
- `GET /api/settlements`
- `GET /api/verify-ledger/:id`
- `GET /api/health`

All mutating routes require an `idempotencyKey`.

### Service Layer

`EventService` is the main financial write service. It writes events, updates the read model, and creates ledger entries inside serializable transactions.

`PaymentService` handles the payment orchestration. It starts payment processing, calls the Stripe mock with an idempotency key, confirms successful payment, or reverts the order to pending if the card is declined.

`SettlementService` handles daily settlement and settlement history.

`LedgerService` reads ledger entries and computes debit/credit totals.

### Database Layer

PostgreSQL is used because financial writes need strong transactional guarantees. The schema uses:

- `DECIMAL(18,4)` for money
- Unique `idempotencyKey` for event idempotency
- Unique `(aggregateId, version)` for event sequence safety
- A ledger check constraint so a row cannot have both debit and credit
- Serializable transactions for financial mutation paths

## Event Sourcing Design

Each order is an aggregate. Every important change to an order is stored as an event:

- `ORDER_CREATED`
- `PAYMENT_PROCESSING`
- `PAYMENT_CONFIRMED`
- `PAYMENT_FAILED`
- `FEE_CALCULATED`
- `ORDER_SHIPPED`
- `ORDER_DELIVERED`
- `REFUND_COMPLETED`
- `SETTLEMENT_PROCESSED`

Events are immutable. The application does not edit old events to change history. If something new happens, a new event is appended.

The integer `version` field orders events per order. For example:

| Version | Event |
|---:|---|
| 1 | ORDER_CREATED |
| 2 | PAYMENT_PROCESSING |
| 3 | PAYMENT_CONFIRMED |
| 4 | FEE_CALCULATED |
| 5 | ORDER_SHIPPED |
| 6 | ORDER_DELIVERED |
| 7 | SETTLEMENT_PROCESSED |

This makes replay possible. If the read model needs to be rebuilt, events can be read in version order.

## Ledger Design

The ledger follows double-entry bookkeeping. Every financial event creates equal debits and credits.

For a $100 order:

| Step | Debit | Credit |
|---|---|---|
| Order created | ORDER_BALANCE 100.0000 | ORDER_PENDING 100.0000 |
| Payment confirmed | PAYMENT_RECEIVED 100.0000 | ORDER_BALANCE 100.0000 |
| Fee calculated | FEES_OWED 3.0000 | PAYMENT_RECEIVED 3.0000 |
| Settlement | SELLER_PAYOUT 97.0000 | PAYMENT_RECEIVED 97.0000 |

Total debits equal total credits, so the order ledger is balanced.

The ledger is separate from the event log because events describe business facts, while ledger entries describe accounting effects. This separation makes auditing clearer.

## Idempotency Design

Network retries can happen after the server has already processed a request. Without idempotency, retries could duplicate orders, charges, fees, or settlements.

The system handles this by requiring an `idempotencyKey` for every mutation:

- Order, payment, fee, refund, shipping, and delivery events store their key in `EventLog`.
- Settlement stores its key in `Settlement`.
- The Stripe mock also stores charge results by payment-scoped idempotency key.

If the same key is received again, the service returns the existing result instead of creating a duplicate financial effect.

## Concurrency Design

The system uses three layers of protection:

1. **Serializable transactions**
   - Financial writes run with PostgreSQL Serializable isolation.
   - This prevents transaction anomalies under concurrent access.

2. **Optimistic locking**
   - Each order has a `version`.
   - Updates include the current version in the `WHERE` clause.
   - If another request already changed the order, the update affects zero rows and the service returns `VersionConflictError`.

3. **Database uniqueness constraints**
   - `EventLog.idempotencyKey` prevents duplicate events.
   - `EventLog(aggregateId, version)` prevents duplicate event versions.
   - `Settlement.settlementDate` prevents duplicate settlement for the same day.

## Decimal Precision

Money is never calculated with JavaScript floating point. The backend uses:

- Decimal strings in API payloads
- Decimal.js for calculations
- PostgreSQL `DECIMAL(18,4)` for storage

The frontend also avoids floating-point display drift by using scaled integer string arithmetic for totals and running ledger balance.

Examples:

- `1 * 0.03 = 0.0300`
- `10 * 0.03 = 0.3000`
- `999999.99 * 0.03 = 29999.9997`

## Refund Design

Refunds are allowed from `PAID` and `FEE_CALCULATED`.

If the order was paid but no fee was calculated, refund reverses the payment effect:

- Debit `ORDER_BALANCE`
- Credit `PAYMENT_RECEIVED`

If the fee was already calculated, the system also reverses the fee effect:

- Debit `PAYMENT_RECEIVED`
- Credit `FEES_OWED`

The order version is advanced to match the final refund event, so event sequence and read model stay aligned.

## Settlement Design

Settlement processes delivered orders for a selected UTC date.

The service:

1. Checks whether the settlement key or date already exists.
2. Finds delivered orders in the date range.
3. Excludes orders that already have `SETTLEMENT_PROCESSED`.
4. Calculates gross payment, fees, and net payout.
5. Writes settlement events and payout ledger entries.
6. Stores a settlement record with totals and processed order IDs.

Running settlement twice for the same date returns the existing settlement instead of creating duplicate payouts.

## Frontend Overview

The frontend is a Next.js 14 seller dashboard.

It includes:

- Dashboard statistics
- Order table with filtering and sorting
- Create order modal
- Order detail page
- Order status card
- Ledger audit trail
- Ledger balance verification
- Settlement preview
- Settlement execution
- Settlement history

The UI refreshes order and ledger data with polling intervals and refetches immediately after user actions.

## Testing and Verification

The backend test suite covers:

- Happy path
- Idempotency
- Ledger balance
- Decimal precision
- Concurrent order creation
- Concurrent payment conflict
- Settlement idempotency
- Invalid state transitions
- Projection consistency
- Refund behavior
- Stripe failure recovery

The backend also includes a stress script:

```bash
API_BASE_URL=http://localhost:3001/api ORDER_COUNT=1000 TARGET_MS=10000 npm run stress:orders
```

The script creates many orders through the real HTTP API and verifies sampled ledger balances.

## Deployment

Expected deployment targets:

- Frontend: Vercel
- Backend: Railway or Render
- Database: Supabase PostgreSQL

The backend exposes `/api/health` so deployment health can be checked quickly.
