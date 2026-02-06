ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "capacity" INTEGER;
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "spots_limited" BOOLEAN;
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "early_arrival_hint" VARCHAR(100);
