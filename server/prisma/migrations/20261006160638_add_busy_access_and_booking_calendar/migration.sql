-- CreateEnum
CREATE TYPE "BusyAccess" AS ENUM ('READABLE', 'UNREADABLE', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "calendarId" UUID;

-- AlterTable
ALTER TABLE "Calendar" ADD COLUMN     "busyAccess" "BusyAccess" NOT NULL DEFAULT 'UNKNOWN';

-- CreateIndex
CREATE INDEX "Booking_calendarId_idx" ON "Booking"("calendarId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE SET NULL ON UPDATE CASCADE;
