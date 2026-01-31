-- Add PublishMethod enum
CREATE TYPE "PublishMethod" AS ENUM ('ai_auto', 'human_review', 'provider_direct');

-- Add AI Publishing Decision fields to canonical_events
ALTER TABLE "canonical_events" ADD COLUMN "age_rating" VARCHAR(10);
ALTER TABLE "canonical_events" ADD COLUMN "published_by" "PublishMethod";
ALTER TABLE "canonical_events" ADD COLUMN "decision_reason" VARCHAR(255);
ALTER TABLE "canonical_events" ADD COLUMN "ai_flags" JSONB DEFAULT '{}';

-- Add AI Summary fields to canonical_events
ALTER TABLE "canonical_events" ADD COLUMN "ai_summary_short" VARCHAR(300);
ALTER TABLE "canonical_events" ADD COLUMN "ai_summary_highlights" JSONB DEFAULT '[]';
ALTER TABLE "canonical_events" ADD COLUMN "ai_fit_blurb" VARCHAR(150);
ALTER TABLE "canonical_events" ADD COLUMN "ai_summary_confidence" DECIMAL(3, 2);

-- Add Age Fit Buckets to canonical_events
ALTER TABLE "canonical_events" ADD COLUMN "age_fit_0_2" SMALLINT;
ALTER TABLE "canonical_events" ADD COLUMN "age_fit_3_5" SMALLINT;
ALTER TABLE "canonical_events" ADD COLUMN "age_fit_6_9" SMALLINT;
ALTER TABLE "canonical_events" ADD COLUMN "age_fit_10_12" SMALLINT;
ALTER TABLE "canonical_events" ADD COLUMN "age_fit_13_15" SMALLINT;

-- Add index for age_rating
CREATE INDEX "canonical_events_age_rating_idx" ON "canonical_events"("age_rating");

-- Add fun_score to event_scores
ALTER TABLE "event_scores" ADD COLUMN "fun_score" SMALLINT;
