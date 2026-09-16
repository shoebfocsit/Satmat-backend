-- Market bidding guards: per-market timezone + admin kill-switch,
-- plus the idempotency ledger for bid placement.
-- IF NOT EXISTS is used throughout so the migration is safe to replay on
-- databases that were partially healed by the runtime self-heal SQL.

-- AlterTable
ALTER TABLE "Market" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE "Market" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE IF NOT EXISTS "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "statusCode" INTEGER,
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyKey_userId_key_key" ON "IdempotencyKey"("userId", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IdempotencyKey_userId_idx" ON "IdempotencyKey"("userId");
