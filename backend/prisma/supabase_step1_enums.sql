-- STEP 1: Create new enums
-- Execute this FIRST in Supabase SQL Editor

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
