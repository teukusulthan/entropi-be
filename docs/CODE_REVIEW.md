# Code Review: Provided Payment Snippet

The reviewed snippet has several financial-system defects. The implementation in this repository addresses these issues with idempotency keys, state-machine validation, serializable transactions, optimistic locking, and double-entry ledger writes.

## Findings

1. **Check-then-act race on payment status**
   - The snippet reads `order.payment_received > 0` before charging and updating.
   - Two concurrent requests can both observe zero and both charge the card.
   - The project fixes this with `Order.version`, `UPDATE ... WHERE version = currentVersion`, and `VersionConflictError`.

2. **Idempotency check happens too late for external side effects**
   - The snippet checks idempotency before `stripeAPI.charge`, but the external charge itself is not keyed.
   - If Stripe succeeds and the database write fails, a retry can charge again.
   - The project passes a stable Stripe idempotency key to the mock charge path and reuses the original charge for retries.

3. **Event append and order update are not atomic**
   - The snippet creates the event and then updates the order in separate operations.
   - A failure between those writes leaves an event stream that disagrees with the read model.
   - The project wraps event, ledger, and read-model writes in one serializable transaction.

4. **No strict state-machine transition**
   - The snippet only checks whether payment was received.
   - It does not verify that the order is in the correct state for payment confirmation.
   - The project validates transitions such as `PENDING -> PAYMENT_PROCESSING -> PAID`.

5. **Version is calculated from stale data**
   - The snippet writes `version: order.version + 1` without guarding that the row still has the same version.
   - Concurrent writers can collide or produce duplicate event versions.
   - The project enforces `Unique(aggregateId, version)` and optimistic row updates.

6. **No double-entry ledger write**
   - The snippet records only the event and read-model update.
   - It does not debit and credit financial accounts, so reconciliation is impossible.
   - The project writes balanced ledger entries for order creation, payment, fees, refunds, and settlement.

7. **No decimal normalization**
   - The snippet passes `amount` directly through without showing decimal-string validation or fixed precision.
   - The project stores money as PostgreSQL `DECIMAL(18,4)` and uses `Decimal.js` in service calculations.

8. **Weak idempotency conflict semantics**
   - The snippet returns any event with the same idempotency key without checking whether it belongs to the same intended operation.
   - In production, idempotency keys should be scoped and validated against request intent.
   - The project uses unique operation keys and separate settlement idempotency records.
