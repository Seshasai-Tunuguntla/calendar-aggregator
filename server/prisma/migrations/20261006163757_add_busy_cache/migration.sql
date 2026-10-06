-- CreateTable
CREATE TABLE "BusyCache" (
    "id" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "intervals" JSONB NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BusyCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusyCache_hostId_fetchedAt_idx" ON "BusyCache"("hostId", "fetchedAt");

-- CreateIndex
CREATE INDEX "BusyCache_fetchedAt_idx" ON "BusyCache"("fetchedAt");

-- AddForeignKey
ALTER TABLE "BusyCache" ADD CONSTRAINT "BusyCache_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
