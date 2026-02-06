ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "noise_level" "NoiseLevel";
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "has_seating" BOOLEAN;
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "typical_wait_minutes" SMALLINT;
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "food_drink_allowed" BOOLEAN;
