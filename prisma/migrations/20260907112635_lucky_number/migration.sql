-- CreateTable
CREATE TABLE "LuckyNumber" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "ank" TEXT NOT NULL,
    "finalAnk" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'vip',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LuckyNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LuckyNumber_date_key" ON "LuckyNumber"("date");

-- CreateIndex
CREATE INDEX "LuckyNumber_date_idx" ON "LuckyNumber"("date");
