ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "age_recommendation_text" VARCHAR(100);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "sibling_friendly" BOOLEAN;
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "language" VARCHAR(50);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "complexity_level" "ComplexityLevel";
