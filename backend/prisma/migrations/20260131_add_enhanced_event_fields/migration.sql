-- Migration: Add enhanced event fields for family-friendly features
-- This adds: venue details, availability status, age info, language, stressfree, capacity, recurrence, transit

-- Create new enums (if they don't exist)
DO $$ BEGIN
    CREATE TYPE "AvailabilityStatus" AS ENUM ('available', 'sold_out', 'waitlist', 'registration_required', 'unknown');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "ComplexityLevel" AS ENUM ('simple', 'moderate', 'advanced');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "NoiseLevel" AS ENUM ('quiet', 'moderate', 'loud');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add venue details columns
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "venue_name" VARCHAR(200);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "postal_code" VARCHAR(10);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "city" VARCHAR(100);

-- Add pricing details
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "price_details" JSONB DEFAULT '{}';

-- Add ticket/booking status
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "availability_status" "AvailabilityStatus" DEFAULT 'unknown';
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "registration_deadline" TIMESTAMPTZ;

-- Add extended age info
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "age_recommendation_text" VARCHAR(100);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "sibling_friendly" BOOLEAN;

-- Add language & comprehension
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "language" VARCHAR(50);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "complexity_level" "ComplexityLevel";

-- Add stressfree details
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "noise_level" "NoiseLevel";
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "has_seating" BOOLEAN;
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "typical_wait_minutes" SMALLINT;
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "food_drink_allowed" BOOLEAN;

-- Add capacity
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "capacity" INTEGER;
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "spots_limited" BOOLEAN;
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "early_arrival_hint" VARCHAR(100);

-- Add series / recurrence
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "recurrence_rule" VARCHAR(100);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "parent_series_id" UUID REFERENCES "canonical_events"(id);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "next_occurrences" JSONB DEFAULT '[]';

-- Add transit/arrival info
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "transit_stop" VARCHAR(100);
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "transit_walk_minutes" SMALLINT;
ALTER TABLE "canonical_events" ADD COLUMN IF NOT EXISTS "has_parking" BOOLEAN;

-- Create indexes for the new fields
CREATE INDEX IF NOT EXISTS "canonical_events_availability_status_idx" ON "canonical_events"("availability_status");
CREATE INDEX IF NOT EXISTS "canonical_events_parent_series_id_idx" ON "canonical_events"("parent_series_id");
CREATE INDEX IF NOT EXISTS "canonical_events_city_idx" ON "canonical_events"("city");
