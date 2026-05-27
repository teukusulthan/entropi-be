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
   - Call StripeMock.charge() (with simulated latency)
   - On success: EventService.recordPayment() creates PAYMENT_CONFIRMED event + ledger entries
   - On failure: EventService.revertToPaymentPending() reverts status

### Fee Calculation
1. EventService.calculateFees() in serializable transaction:
   - Validate PAID -> FEE_CALCULATED transition
   - Calculate fee using Decimal.js (amount * 0.03)
   - Create FEE_CALCULATED event
   - Create ledger entries (debit FEES_OWED, credit PAYMENT_RECEIVED)

### Settlement
1. EventService.dailySettlement() processes all FEE_CALCULATED orders:
   - Check idempotency key and settlement date
   - Sum payments and fees using Decimal.js
   - Create SETTLEMENT_PROCESSED events per order
   - Create settlement payout ledger entries per order
   - Create Settlement aggregate record with processed order IDs
   - Repeated settlement calls return the existing settlement result

### Fulfillment
1. EventService.markOrderShipped() validates FEE_CALCULATED -> SHIPPED and emits ORDER_SHIPPED.
2. EventService.markOrderDelivered() validates SHIPPED -> DELIVERED and emits ORDER_DELIVERED.

## Technology Choices

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| HTTP Framework | Fastify | High performance, plugin system, schema validation |
| ORM | Prisma | Type-safe queries, migration management, transaction support |
| Database | PostgreSQL | ACID compliance, serializable isolation, CHECK constraints |
| Precision | Decimal.js | No floating-point errors for financial calculations |
| Validation | Zod | Runtime type checking, composable schemas |
| Testing | Jest | Mature ecosystem, mocking support, parallel execution |
