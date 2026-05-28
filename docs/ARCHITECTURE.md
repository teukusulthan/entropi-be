# Architecture

## Overview

Entropi Backend implements an event-sourced financial system with double-entry bookkeeping. The architecture separates the write model (event log) from the read model (order projection), ensuring a complete audit trail of all financial operations.

## Event Sourcing Pattern

```
Command (e.g. "Pay Order")
    |
    v
+-------------------+
| Validate State    |  <-- State machine checks
| Machine           |
+-------------------+
    |
    v
+-------------------+
| Append Event      |  <-- Immutable, append-only
| to Event Log      |
+-------------------+
    |
    v
+-------------------+
| Update Read Model |  <-- Order table (projection)
| (Projection)      |
+-------------------+
    |
    v
+-------------------+
| Create Ledger     |  <-- Double-entry bookkeeping
| Entries           |
+-------------------+
```

### Why Append-Only Event Log

1. **Audit Trail**: Every state change is recorded permanently. No data is ever lost or overwritten.
2. **Temporal Queries**: You can reconstruct the state of any order at any point in time by replaying events.
3. **Debugging**: When something goes wrong, the event log tells you exactly what happened and when.
4. **Compliance**: Financial regulations often require immutable records of all transactions.
5. **Event Replay**: The read model can be rebuilt from scratch by replaying all events.

### Read Model Projection Strategy

The `Order` table serves as a read model -- a denormalized projection optimized for queries. It is updated transactionally alongside each new event. This "inline projection" approach trades off some flexibility (vs. async projections) for strong consistency: the read model is always up-to-date within the same transaction.

If needed, additional read models can be built by replaying the event log. The `OrderProjection.rebuildFromEvents()` method demonstrates this capability.

## Component Diagram

```
+------------------------------------------+
|            Fastify HTTP Server            |
|  +------+  +--------+  +----------+      |
|  |Health |  |Order   |  |Settlement|      |
|  |Routes |  |Routes  |  |Routes   |      |
|  +------+  +--------+  +----------+      |
|  |Payment Routes |                        |
|  +---------------+                        |
+------------------------------------------+
          |                    |
          v                    v
+-------------------+  +-------------------+
|  Payment Service  |  | Settlement Service|
|  (Stripe Mock)    |  |                   |
+-------------------+  +-------------------+
          |                    |
          v                    v
+------------------------------------------+
|            Event Service                  |
|  - recordOrder()                          |
|  - recordPayment()                        |
|  - calculateFees()                        |
|  - dailySettlement()                      |
|  - processRefund()                        |
|  - verifyLedgerBalance()                  |
+------------------------------------------+
     |              |              |
     v              v              v
+---------+  +----------+  +------------+
| Order   |  | EventLog |  | LedgerEntry|
| (Read)  |  | (Write)  |  | (Double    |
|         |  |          |  |  Entry)    |
+---------+  +----------+  +------------+
                                   |
                            +------------+
                            | Settlement |
                            +------------+
```

## Data Flow

### Order Creation
1. API receives POST /api/orders
2. Zod validates request body
3. EventService.recordOrder() runs in serializable transaction:
   - Check idempotency key
   - Create Order (read model) with status PENDING
   - Create EventLog entry (ORDER_CREATED)
   - Create 2 LedgerEntry rows (debit ORDER_BALANCE, credit ORDER_PENDING)

### Payment Processing
1. API receives POST /api/orders/:id/pay
2. PaymentService.processPayment() orchestrates:
   - Transition order to PAYMENT_PROCESSING (with version check)
   - Call StripeMock.charge() with a payment-scoped idempotency key
   - On success: EventService.recordPayment() creates PAYMENT_CONFIRMED event + ledger entries
   - On failure: EventService.revertToPaymentPending() reverts status
   - If the payment flow is retried after a processing event was already recorded, the Stripe mock returns the original charge for the same key.

### Fee Calculation
1. EventService.calculateFees() in serializable transaction:
   - Validate PAID -> FEE_CALCULATED transition
   - Calculate fee using Decimal.js (amount * 0.03)
   - Create FEE_CALCULATED event
   - Create ledger entries (debit FEES_OWED, credit PAYMENT_RECEIVED)

### Settlement
1. EventService.dailySettlement() processes all DELIVERED orders for the given date:
   - Check idempotency key and settlement date
   - Query DELIVERED orders with updatedAt within the settlement date range and no existing SETTLEMENT_PROCESSED event
   - Sum payments and fees using Decimal.js
   - Create SETTLEMENT_PROCESSED events per order and increment order version
   - Create settlement payout ledger entries per order
   - Create Settlement aggregate record with processed order IDs
   - Repeated settlement calls return the existing settlement result

### Fulfillment
1. EventService.markOrderShipped() validates FEE_CALCULATED -> SHIPPED and emits ORDER_SHIPPED.
2. EventService.markOrderDelivered() validates SHIPPED -> DELIVERED and emits ORDER_DELIVERED.

### Refunds
1. EventService.processRefund() validates PAID/FEE_CALCULATED -> REFUNDED.
2. Payment reversal creates debit ORDER_BALANCE and credit PAYMENT_RECEIVED entries.
3. If fees were calculated, a second fee-reversal event restores PAYMENT_RECEIVED and credits FEES_OWED.
4. The order version is advanced to the final refund event version so the read model and event stream stay aligned.

## Technology Choices

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| HTTP Framework | Fastify | High performance, plugin system, schema validation |
| ORM | Prisma | Type-safe queries, migration management, transaction support |
| Database | PostgreSQL | ACID compliance, serializable isolation, CHECK constraints |
| Precision | Decimal.js | No floating-point errors for financial calculations |
| Validation | Zod | Runtime type checking, composable schemas |
| Testing | Jest | Mature ecosystem, mocking support, parallel execution |

## Database Model Responsibilities

### Order

`Order` is the query-optimized read model. It stores the current operational state of an order: customer, amount, payment method, status, received payment amount, calculated fee, version, and timestamps. It is not the source of truth for historical changes. Its purpose is to make dashboard and API reads fast without replaying the full event stream for every request.

### EventLog

`EventLog` is the immutable write model. Every meaningful state transition is represented as an event with an aggregate ID, event type, payload, version, timestamp, and idempotency key. The pair `(aggregateId, version)` gives each order a strict event sequence. The unique `idempotencyKey` prevents duplicate event creation when clients retry requests.

### LedgerEntry

`LedgerEntry` records the accounting effect of each financial event. It links back to both the order and the event that produced it. Each row contains exactly one side of a double-entry posting: either a debit or a credit. This design makes the ledger easy to audit and reconcile while keeping the event payload focused on business facts.

### Settlement

`Settlement` represents a daily payout batch. It stores the settlement date, idempotency key, totals, order count, processed order IDs, status, and creation timestamp. It also prevents a settlement for the same date from being created twice.

## State Machine

The order lifecycle is intentionally strict:

```
PENDING
  -> PAYMENT_PROCESSING
  -> PAID
  -> FEE_CALCULATED
  -> SHIPPED
  -> DELIVERED
```

Refunds are allowed from `PAID` and `FEE_CALCULATED`. Delivered and refunded orders are terminal states. Invalid transitions are rejected with `InvalidTransitionError`, which prevents financial actions from happening out of order.

## API Layer

The Fastify API is intentionally thin:

1. Validate request body with Zod.
2. Validate idempotency key for mutating endpoints.
3. Call the appropriate service.
4. Convert domain errors to HTTP responses.

Business rules stay in services, not route handlers. This keeps the API layer simple and makes core behavior easier to test.

## Service Layer

### EventService

`EventService` owns the financial write path. It creates events, updates the order projection, and writes ledger entries inside the same serializable transaction. The main methods are:

- `recordOrder`
- `startPaymentProcessing`
- `recordPayment`
- `calculateFees`
- `processRefund`
- `markOrderShipped`
- `markOrderDelivered`
- `dailySettlement`
- `verifyLedgerBalance`

### PaymentService

`PaymentService` orchestrates payment flow. It does not write ledger entries directly. Instead, it moves the order to `PAYMENT_PROCESSING`, calls the Stripe mock with a stable key, then confirms payment through `EventService.recordPayment`.

### SettlementService

`SettlementService` provides a small facade for settlement execution, settlement history, and ledger verification endpoints.

### LedgerService

`LedgerService` reads ledger entries and calculates debit/credit totals for audit views.

## Replay and Auditability

The current `Order` row can be rebuilt from `EventLog` using the projection logic. This matters because the event stream is the historical record. If the read model were corrupted or needed a new shape, events can be replayed in version order to reconstruct status, payment received, fee amount, and lifecycle state.

The ledger provides a separate audit trail for money movement. Events answer "what happened"; ledger entries answer "what was the accounting effect." Keeping those concerns separate makes the system easier to explain and verify.
