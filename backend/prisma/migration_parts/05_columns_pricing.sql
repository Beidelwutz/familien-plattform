ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "price_details" JSONB DEFAULT '{}';
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "availability_status" "AvailabilityStatus" DEFAULT 'unknown';
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "registration_deadline" TIMESTAMPTZ;
