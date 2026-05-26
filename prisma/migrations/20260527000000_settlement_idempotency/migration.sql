ALTER TABLE "Settlement"
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "processedOrderIds" JSONB NOT NULL DEFAULT '[]';

UPDATE "Settlement"
SET "idempotencyKey" = 'settlement-' || "settlementDate"::text
WHERE "idempotencyKey" IS NULL;

ALTER TABLE "Settlement"
ALTER COLUMN "idempotencyKey" SET NOT NULL;

CREATE UNIQUE INDEX "Settlement_idempotencyKey_key" ON "Settlement"("idempotencyKey");
