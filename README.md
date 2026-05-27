# Entropi Backend

Financial event-sourcing backend with double-entry bookkeeping.

## Architecture

- **Event Sourcing**: All state changes recorded as immutable events in append-only log
- **Double-Entry Ledger**: Every operation creates balanced debit/credit entries
- **CQRS**: Separate write model (event log) and read model (order projection)
- **Optimistic Concurrency**: Version-based conflict detection with serializable transactions
- **Idempotency**: All mutations require idempotency keys for exactly-once semantics

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | Fastify 5 |
| ORM | Prisma 6 |
| Database | PostgreSQL |
| Precision | Decimal.js |
| Validation | Zod |
| Testing | Jest |

## Getting Started

```bash
cp .env.example .env
# Edit .env with your database credentials
npm install
npx prisma generate
npx prisma db push
npm run dev
```

## Running Tests

```bash
npm test
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/orders | Create order |
| GET | /api/orders | List orders |
| GET | /api/orders/:id | Get order detail |
| POST | /api/orders/:id/pay | Process payment |
| POST | /api/orders/:id/fees | Calculate fees |
| POST | /api/orders/:id/refund | Process refund |
| POST | /api/orders/:id/ship | Mark shipped |
| POST | /api/orders/:id/deliver | Mark delivered |
| GET | /api/orders/:id/ledger | Get ledger entries |
| POST | /api/settle | Run daily settlement |
| GET | /api/verify-ledger/:id | Verify ledger balance |
| GET | /api/health | Health check |

All mutating endpoints require an `idempotencyKey` in the request body.

## Key Design Decisions

- **Decimal(18,4)**: Sub-cent precision, no IEEE 754 errors
- **Serializable isolation**: Correctness under concurrent load (tested with 1,000+ orders)
- **Inline projection**: Read model updated transactionally with events
- **State machine**: Strict validation of order status transitions

See `docs/` for detailed documentation.
