-- Add account lockout fields to users table
ALTER TABLE "users" ADD COLUMN "failed_login_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "locked_until" TIMESTAMPTZ;
ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMPTZ;

-- Create index for checking locked accounts
CREATE INDEX "users_locked_until_idx" ON "users"("locked_until") WHERE "locked_until" IS NOT NULL;
