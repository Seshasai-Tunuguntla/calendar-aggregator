-- CreateTable
CREATE TABLE "DemoState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastResetAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DemoState_pkey" PRIMARY KEY ("id")
);

-- Added by hand (tests/db/constraints.test.ts checks it): one row only, so every server instance
-- reads the same reset time.
ALTER TABLE "DemoState" ADD CONSTRAINT "DemoState_single_row_check" CHECK ("id" = 1);
