-- =============================================
-- AI Jobs Table for Persistent Job Tracking
-- Run this in Supabase SQL Editor
-- =============================================

-- Step 1: Create the enum type (if not exists)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AiJobStatus') THEN
        CREATE TYPE "AiJobStatus" AS ENUM ('running', 'completed', 'failed', 'stale', 'cancelled');
    END IF;
END $$;

-- Step 2: Create the table
CREATE TABLE IF NOT EXISTS "ai_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" "AiJobStatus" NOT NULL DEFAULT 'running',
    "total" INTEGER NOT NULL,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "current_event_id" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "summary" JSONB,
    "total_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_by" TEXT,
    CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id")
);

-- Step 3: Create indexes (will skip if already exist)
CREATE INDEX IF NOT EXISTS "ai_jobs_status_idx" ON "ai_jobs"("status");
CREATE INDEX IF NOT EXISTS "ai_jobs_started_at_idx" ON "ai_jobs"("started_at");
CREATE INDEX IF NOT EXISTS "ai_jobs_last_heartbeat_idx" ON "ai_jobs"("last_heartbeat");

-- Verify
SELECT 'ai_jobs table created successfully' as result;
SELECT COUNT(*) as row_count FROM "ai_jobs";
