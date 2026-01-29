-- Add email verification fields to users table
ALTER TABLE "users" ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ;

-- Create index for email verification queries
CREATE INDEX "users_email_verified_idx" ON "users"("email_verified");
