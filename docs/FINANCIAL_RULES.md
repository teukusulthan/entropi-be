# Financial Rules

## Why Decimal(18, 4)

PostgreSQL's `DECIMAL(18, 4)` type provides:
- **18 total digits**: Supports values up to 99,999,999,999,999.9999
- **4 decimal places**: Sub-cent precision for fee calculations and currency conversions
- **No IEEE 754 errors**: Unlike JavaScript's `number` type, `DECIMAL` stores values exactly

### The Floating-Point Problem

```javascript
// JavaScript number (IEEE 754):
0.1 + 0.2 === 0.3  // false! (0.30000000000000004)
10 * 0.03 === 0.3   // false! (0.30000000000000004)

// Decimal.js:
new Decimal('0.1').plus('0.2').equals('0.3')  // true
new Decimal('10').mul('0.03').equals('0.3')    // true
```

We use `Decimal.js` on the application side to match PostgreSQL's exact arithmetic. All monetary values are passed as strings to avoid any JavaScript number precision loss.

## Why Separate Ledger Table

The `LedgerEntry` table exists separately from the `EventLog` for several reasons:

1. **Separation of concerns**: Events describe _what happened_; ledger entries describe _the financial impact_.
2. **Audit trail**: The ledger provides a complete, queryable record of all money movements.
3. **Double-entry invariant**: The CHECK constraint `(debit IS NOT NULL AND credit IS NULL) OR (debit IS NULL AND credit IS NOT NULL)` enforces single-sided entries. Balanced debits and credits are verified at the application level.
4. **Account-level queries**: The `account` field and index allow efficient queries like "show all PAYMENT_RECEIVED entries" or "sum all FEES_OWED."
5. **Reconciliation**: At any time, `SUM(debits) = SUM(credits)` can be verified per order or globally.

## Why IdempotencyKey

Distributed systems face the challenge of exactly-once processing:

- **At-most-once**: Fire and forget (might lose operations)
- **At-least-once**: Retry on failure (might duplicate operations)
- **Exactly-once**: Achieved via idempotency keys

Each operation has a unique `idempotencyKey`. Order-level mutations store it in the `EventLog`; settlement stores it on the `Settlement` aggregate because one settlement spans many orders. If a client retries with the same key, the system returns the original result instead of creating a duplicate. This is critical for:

- **Payment processing**: Prevents double-charging customers
- **Fee calculation**: Prevents double-counting fees
- **Settlement**: Prevents double-payouts to sellers

## Why Version as Integer

The `version` field on `Order` serves as an optimistic concurrency control mechanism:

1. **Cheap conflict detection**: A simple integer comparison in the WHERE clause
2. **Natural event ordering**: Events are numbered 1, 2, 3, ... making it trivial to detect gaps or duplicates
3. **Composite unique key**: `(aggregateId, version)` on EventLog ensures no two events claim the same position in an order's history
4. **No UUIDs for ordering**: UUIDs are random and unordered; integers give a clear sequence

## Double-Entry Bookkeeping Rules

Every financial event produces exactly two ledger entries with equal amounts:

| Event | Debit Account | Credit Account | Amount |
|-------|--------------|----------------|--------|
| Order Created | ORDER_BALANCE | ORDER_PENDING | Order amount |
| Payment Confirmed | PAYMENT_RECEIVED | ORDER_BALANCE | Payment amount |
| Fee Calculated | FEES_OWED | PAYMENT_RECEIVED | Fee amount |
| Settlement Processed | SELLER_PAYOUT | PAYMENT_RECEIVED | Net payout |
| Refund | ORDER_BALANCE | PAYMENT_RECEIVED | Refund amount |
| Refund Fee Reversal | PAYMENT_RECEIVED | FEES_OWED | Fee amount |

### Invariant: Debits = Credits

At all times, for any order:

```
SUM(all debit entries) = SUM(all credit entries)
```

This is verified by `EventService.verifyLedgerBalance()` and exposed via `GET /api/verify-ledger/:id`.

### Account Flow (Happy Path)

For a $100 order with 3% fee:

```
Step 1 - Order Created:
  ORDER_BALANCE    DR  100.0000
  ORDER_PENDING         CR  100.0000

Step 2 - Payment Confirmed:
  PAYMENT_RECEIVED DR  100.0000
  ORDER_BALANCE         CR  100.0000

Step 3 - Fee Calculated:
  FEES_OWED        DR    3.0000
  PAYMENT_RECEIVED      CR    3.0000

Step 4 - Settlement:
  SELLER_PAYOUT    DR   97.0000
  PAYMENT_RECEIVED      CR   97.0000

Final balances:
  Total Debits:  300.0000
  Total Credits: 300.0000
  Balanced: true
```

## Fee Calculation Rules

- **Rate**: 3% flat on the payment amount
- **Precision**: Calculated using Decimal.js, stored as DECIMAL(18, 4)
- **Formula**: `feeAmount = paymentAmount * 0.03`
- **Rounding**: ROUND_HALF_UP (standard financial rounding)
- **Timing**: Fees are calculated after payment confirmation, before settlement
- **Frontend display**: Dashboard totals and running balances use scaled integer string arithmetic instead of JavaScript floating point.

### Examples

| Payment Amount | Fee (3%) | Net Payout |
|---------------|----------|------------|
| $1.00 | $0.0300 | $0.9700 |
| $10.00 | $0.3000 | $9.7000 |
| $100.00 | $3.0000 | $97.0000 |
| $999,999.99 | $29,999.9997 | $969,999.9903 |
| $0.01 | $0.0003 | $0.0097 |

## Account Definitions

| Account | Meaning |
|---|---|
| `ORDER_BALANCE` | Temporary receivable created when an order is recorded and cleared when payment is received. |
| `ORDER_PENDING` | Offset account used at order creation so the initial order record is balanced. |
| `PAYMENT_RECEIVED` | Gross funds received from the customer before fees and payout. |
| `FEES_OWED` | Platform fee amount calculated from the paid amount. |
| `SELLER_PAYOUT` | Net amount payable to the seller during settlement. |

## Ledger Examples by Operation

### Order Creation: $100.0000

| Account | Debit | Credit |
|---|---:|---:|
| ORDER_BALANCE | 100.0000 | |
| ORDER_PENDING | | 100.0000 |

### Payment Confirmation: $100.0000

| Account | Debit | Credit |
|---|---:|---:|
| PAYMENT_RECEIVED | 100.0000 | |
| ORDER_BALANCE | | 100.0000 |

### Fee Calculation: 3%

| Account | Debit | Credit |
|---|---:|---:|
| FEES_OWED | 3.0000 | |
| PAYMENT_RECEIVED | | 3.0000 |

### Settlement: $97.0000 Net Payout

| Account | Debit | Credit |
|---|---:|---:|
| SELLER_PAYOUT | 97.0000 | |
| PAYMENT_RECEIVED | | 97.0000 |

### Refund After Fee Calculation

If an order is refunded after fees were calculated, the system reverses both payment and fee effects:

| Account | Debit | Credit |
|---|---:|---:|
| ORDER_BALANCE | 100.0000 | |
| PAYMENT_RECEIVED | | 100.0000 |
| PAYMENT_RECEIVED | 3.0000 | |
| FEES_OWED | | 3.0000 |

The entries remain balanced because every debit has an equal credit.

## Validation Rules

- API inputs represent money as strings.
- Services convert money strings to `Decimal` before calculation.
- Values are stored as `DECIMAL(18,4)`.
- Ledger verification sums debits and credits with Decimal arithmetic.
- Frontend totals use scaled integer string arithmetic for display.
- JavaScript floating point is not used for financial calculations.
