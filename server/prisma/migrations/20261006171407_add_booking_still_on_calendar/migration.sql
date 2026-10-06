-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "stillOnCalendar" BOOLEAN NOT NULL DEFAULT false;

-- Added by hand (tests/db/constraints.test.ts checks it): only a cancelled booking can be waiting
-- for its event to be removed from the host's calendar.
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_still_on_calendar_check" CHECK (NOT "stillOnCalendar" OR "status" = 'CANCELLED');
