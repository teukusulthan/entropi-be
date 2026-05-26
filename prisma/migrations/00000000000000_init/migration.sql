-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAYMENT_PROCESSING', 'PAID', 'FEE_CALCULATED', 'SHIPPED', 'DELIVERED', 'REFUNDED');
CREATE TYPE "EventType" AS ENUM ('ORDER_CREATED', 'PAYMENT_PROCESSING', 'PAYMENT_CONFIRMED', 'FEE_CALCULATED', 'ORDER_SHIPPED', 'ORDER_DELIVERED', 'REFUND_INITIATED', 'REFUND_COMPLETED', 'SETTLEMENT_PROCESSED');
CREATE TYPE "AccountType" AS ENUM ('ORDER_BALANCE', 'ORDER_PENDING', 'PAYMENT_RECEIVED', 'FEES_OWED', 'SELLER_PAYOUT');
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "paymentReceived" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "feeAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" "EventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "account" "AccountType" NOT NULL,
    "debit" DECIMAL(18,4),
    "credit" DECIMAL(18,4),
    "description" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "settlementDate" TIMESTAMP(3) NOT NULL,
    "totalAmount" DECIMAL(18,4) NOT NULL,
    "totalFees" DECIMAL(18,4) NOT NULL,
    "netPayout" DECIMAL(18,4) NOT NULL,
    "orderCount" INTEGER NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventLog_idempotencyKey_key" ON "EventLog"("idempotencyKey");
CREATE UNIQUE INDEX "EventLog_aggregateId_version_key" ON "EventLog"("aggregateId", "version");
CREATE INDEX "EventLog_aggregateId_version_idx" ON "EventLog"("aggregateId", "version");
CREATE INDEX "EventLog_eventType_idx" ON "EventLog"("eventType");
CREATE INDEX "EventLog_timestamp_idx" ON "EventLog"("timestamp");
CREATE INDEX "LedgerEntry_orderId_idx" ON "LedgerEntry"("orderId");
CREATE INDEX "LedgerEntry_account_idx" ON "LedgerEntry"("account");
CREATE UNIQUE INDEX "Settlement_settlementDate_key" ON "Settlement"("settlementDate");

-- AddForeignKey
ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_aggregateId_fkey" FOREIGN KEY ("aggregateId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EventLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraint: exactly one of debit or credit must be non-null
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "ledger_entry_single_side_check"
  CHECK (
    (debit IS NOT NULL AND credit IS NULL) OR
    (debit IS NULL AND credit IS NOT NULL)
  );
