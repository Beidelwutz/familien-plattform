ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "recurrence_rule" VARCHAR(100);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "next_occurrences" JSONB DEFAULT '[]';
