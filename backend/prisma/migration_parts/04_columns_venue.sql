ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "venue_name" VARCHAR(200);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "postal_code" VARCHAR(10);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "city" VARCHAR(100);
