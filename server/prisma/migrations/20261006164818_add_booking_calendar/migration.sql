-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bookingCalendarId" UUID;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_bookingCalendarId_fkey" FOREIGN KEY ("bookingCalendarId") REFERENCES "Calendar"("id") ON DELETE SET NULL ON UPDATE CASCADE;
