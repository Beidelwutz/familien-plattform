ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "transit_stop" VARCHAR(100);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "transit_walk_minutes" SMALLINT;
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "has_parking" BOOLEAN;
