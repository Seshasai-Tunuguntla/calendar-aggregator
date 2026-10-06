-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('GOOGLE', 'DEMO');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'NEEDS_RECONNECT');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "bufferBeforeMinutes" INTEGER NOT NULL DEFAULT 0,
    "bufferAfterMinutes" INTEGER NOT NULL DEFAULT 0,
    "minNoticeMinutes" INTEGER NOT NULL DEFAULT 240,
    "horizonDays" INTEGER NOT NULL DEFAULT 30,
    "maxPerDay" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "grantedScopes" TEXT[],
    "encryptedRefreshToken" TEXT,
    "encryptedAccessToken" TEXT,
    "tokenKeyVersion" INTEGER,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Calendar" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "externalCalendarId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "countsAsBusy" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityRule" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "AvailabilityRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventType" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "durationMinutes" INTEGER NOT NULL,
    "slotStepMinutes" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EventType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "eventTypeId" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "guestName" TEXT NOT NULL,
    "guestEmail" TEXT NOT NULL,
    "guestTimeZone" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "externalEventId" TEXT,
    "manageTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMPTZ(3),

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoBusyEvent" (
    "id" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DemoBusyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL,
    "resetAtMs" BIGINT NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_handle_key" ON "User"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "CalendarConnection_userId_idx" ON "CalendarConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarConnection_provider_externalAccountId_key" ON "CalendarConnection"("provider", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Calendar_connectionId_externalCalendarId_key" ON "Calendar"("connectionId", "externalCalendarId");

-- CreateIndex
CREATE INDEX "AvailabilityRule_userId_idx" ON "AvailabilityRule"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EventType_userId_slug_key" ON "EventType"("userId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "EventType_id_userId_key" ON "EventType"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_manageTokenHash_key" ON "Booking"("manageTokenHash");

-- CreateIndex
CREATE INDEX "Booking_hostId_startsAt_idx" ON "Booking"("hostId", "startsAt");

-- CreateIndex
CREATE INDEX "DemoBusyEvent_calendarId_startsAt_idx" ON "DemoBusyEvent"("calendarId", "startsAt");

-- CreateIndex
CREATE INDEX "RateLimit_resetAtMs_idx" ON "RateLimit"("resetAtMs");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Calendar" ADD CONSTRAINT "Calendar_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CalendarConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityRule" ADD CONSTRAINT "AvailabilityRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventType" ADD CONSTRAINT "EventType_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_eventTypeId_hostId_fkey" FOREIGN KEY ("eventTypeId", "hostId") REFERENCES "EventType"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemoBusyEvent" ADD CONSTRAINT "DemoBusyEvent_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =================================================================================================
-- Added by hand: constraints Prisma's schema language can't express. tests/db/constraints.test.ts
-- checks that every one of them still exists after all migrations have run, so a later migration
-- can't drop one unnoticed.
-- =================================================================================================

-- btree_gist lets a GiST index compare plain columns with "=", so one exclusion constraint can
-- combine "same host" (uuid, =) with "overlapping time" (range, &&).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Double booking: one host can never have two overlapping confirmed bookings. Ranges are
-- half-open ('[)'), so a booking ending at 10:00 and one starting at 10:00 don't conflict.
-- Cancelled bookings are left out, so their time can be booked again. Postgres checks this
-- atomically, so when two guests race for the same slot, exactly one insert succeeds.
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_no_overlapping_confirmed"
  EXCLUDE USING gist ("hostId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&)
  WHERE ("status" = 'CONFIRMED');

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_ends_after_start_check" CHECK ("endsAt" > "startsAt");
-- cancelledAt is set exactly when the booking is cancelled.
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_cancelled_at_check"
  CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));

-- Weekly rules: valid weekday and minutes, never crossing midnight, and no two rules of one host
-- overlapping on the same weekday (int4range is half-open too, so touching rules are fine). The
-- API rejects all of these first with a clear message; these are the last line of defence.
ALTER TABLE "AvailabilityRule" ADD CONSTRAINT "AvailabilityRule_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7);
ALTER TABLE "AvailabilityRule" ADD CONSTRAINT "AvailabilityRule_minutes_check"
  CHECK (0 <= "startMinute" AND "startMinute" < "endMinute" AND "endMinute" <= 1440);
ALTER TABLE "AvailabilityRule" ADD CONSTRAINT "AvailabilityRule_no_overlap"
  EXCLUDE USING gist ("userId" WITH =, "weekday" WITH =, int4range("startMinute", "endMinute") WITH &&);

-- Scheduling settings in sane ranges.
ALTER TABLE "User" ADD CONSTRAINT "User_settings_check" CHECK (
  "bufferBeforeMinutes" BETWEEN 0 AND 240 AND
  "bufferAfterMinutes" BETWEEN 0 AND 240 AND
  "minNoticeMinutes" BETWEEN 0 AND 43200 AND
  "horizonDays" BETWEEN 1 AND 365 AND
  ("maxPerDay" IS NULL OR "maxPerDay" BETWEEN 1 AND 50)
);
-- Booking-link handles: 3-30 lowercase letters, digits and hyphens, not starting or ending with one.
ALTER TABLE "User" ADD CONSTRAINT "User_handle_check" CHECK ("handle" ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$');
ALTER TABLE "User" ADD CONSTRAINT "User_email_lowercase_check" CHECK ("email" = lower("email"));

ALTER TABLE "EventType" ADD CONSTRAINT "EventType_minutes_check"
  CHECK ("durationMinutes" BETWEEN 5 AND 720 AND "slotStepMinutes" BETWEEN 5 AND 240);
ALTER TABLE "EventType" ADD CONSTRAINT "EventType_slug_check" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$');

ALTER TABLE "DemoBusyEvent" ADD CONSTRAINT "DemoBusyEvent_ends_after_start_check" CHECK ("endsAt" > "startsAt");
