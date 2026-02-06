-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('running', 'completed', 'failed', 'stale', 'cancelled');

-- CreateTable
CREATE TABLE "ai_jobs" (
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

-- CreateIndex
CREATE INDEX "ai_jobs_status_idx" ON "ai_jobs"("status");

-- CreateIndex
CREATE INDEX "ai_jobs_started_at_idx" ON "ai_jobs"("started_at");

-- CreateIndex
CREATE INDEX "ai_jobs_last_heartbeat_idx" ON "ai_jobs"("last_heartbeat");
