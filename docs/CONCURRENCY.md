# Concurrency Strategy

## Overview

Financial systems must handle concurrent operations safely. This document explains the three mechanisms we use: optimistic concurrency control, serializable transactions, and idempotency keys.

## Optimistic Concurrency with Version Field

Every `Order` has a `version` integer that starts at 0 and increments with each state change. When updating an order, we include the current version in the WHERE clause:

```typescript
const updated = await tx.order.updateMany({
  where: { id: orderId, version: currentVersion },
  data: {
    status: newStatus,
    version: currentVersion + 1,
  },
});

if (updated.count === 0) {
  throw new VersionConflictError();
}
```

**How it works:**
1. Read the order and note its version (e.g., version = 3)
2. Perform business logic
3. Update the order WHERE version = 3, SET version = 4
4. If another request already updated it to version = 4, the WHERE clause matches 0 rows
5. Detect the conflict and throw VersionConflictError (HTTP 409)

**Why version as integer:**
- Simple increment is cheap to compute
- Easy to compare and detect conflicts
- Natural ordering of events (version 1, 2, 3, ...)
- Works well with the event log's (aggregateId, version) unique constraint

## Serializable Transactions

All event-producing operations use Prisma's `$transaction` with `Serializable` isolation level:

```typescript
return this.db.$transaction(
  async (tx) => {
    // All reads and writes here are serializable
  },
  {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  }
);
```

**What Serializable gives us:**
- Prevents dirty reads, non-repeatable reads, and phantom reads
- Transactions execute as if they ran sequentially
- PostgreSQL uses SSI (Serializable Snapshot Isolation) which detects conflicts and aborts one transaction
- Combines with optimistic concurrency for defense in depth

**Trade-offs:**
- Higher conflict rate under heavy load (transactions may be aborted and retried)
- Slightly lower throughput than Read Committed
- Worth it for financial correctness

## Idempotency Key Strategy

Every mutating operation requires an `idempotencyKey` -- a unique identifier (typically a UUID) provided by the client.

```typescript
// At the start of every operation:
const existing = await tx.eventLog.findUnique({
  where: { idempotencyKey },
});
if (existing) {
  return { ...existingResult, idempotent: true };
}
```

**How it provides exactly-once semantics:**
1. Client generates a UUID for each intended operation
2. Server checks if an event with that key already exists
3. If yes: return the original result (safe retry)
4. If no: proceed with the operation
5. The EventLog.idempotencyKey has a UNIQUE constraint as a final safety net

**Why idempotency matters:**
- Network failures can cause retries where the server processed the request but the client didn't get the response
- Without idempotency, retrying a payment could charge the customer twice
- The UNIQUE constraint catches any race condition in the check-then-create pattern
- Payment processing uses a separate Stripe mock idempotency key so a retry reuses the original charge result.

## Handling 1000 Concurrent Orders

When 1000 concurrent order creation requests arrive:

1. **Independent orders (different idempotency keys):**
   - Each gets its own serializable transaction
   - PostgreSQL handles concurrent inserts efficiently
   - No conflicts because each order has a unique ID
   - All 1000 succeed

2. **Duplicate orders (same idempotency key):**
   - First request creates the order and event
   - Subsequent requests find the existing event via idempotencyKey
   - All return the same result (HTTP 200 instead of 201)
   - Only one order is created in the database

3. **Concurrent payments on the same order:**
   - First payment reads version = 1
   - Second payment also reads version = 1
   - First payment's UPDATE WHERE version = 1 succeeds
   - Second payment's UPDATE WHERE version = 1 finds 0 rows (version is now 2)
   - Second payment gets VersionConflictError (HTTP 409)
   - Client can retry with fresh state

### API Stress Command

The backend includes a live API stress script:

```bash
cd entropi-backend
API_BASE_URL=http://localhost:3001/api ORDER_COUNT=1000 TARGET_MS=10000 npm run stress:orders
```

The script creates orders through `POST /api/orders`, checks that all returned order IDs are unique, and samples `GET /api/verify-ledger/:id` to verify ledger balance against the configured backend and PostgreSQL database.

## Failure Scenarios

| Scenario | Mechanism | Outcome |
|----------|-----------|---------|
| Network retry on order creation | Idempotency key | Same order returned |
| Two users pay same order | Optimistic concurrency | One succeeds, one gets 409 |
| DB connection drops mid-transaction | Serializable transaction | Everything rolls back |
| Stripe succeeds but DB fails | Stripe idempotency key + revert | Order stays PENDING, can retry |
| Settlement runs twice for same date | Unique settlement date + idempotent readback | Existing settlement is returned |
| Settlement runs for a later date | Existing SETTLEMENT_PROCESSED event exclusion | Previously settled orders are skipped |
