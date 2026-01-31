-- Add field_provenance and field_updated_at to CanonicalEvent
ALTER TABLE "canonical_events" ADD COLUMN "field_provenance" JSONB DEFAULT '{}';
ALTER TABLE "canonical_events" ADD COLUMN "field_updated_at" JSONB DEFAULT '{}';
ALTER TABLE "canonical_events" ADD COLUMN "timezone_original" VARCHAR(50);

-- Add scraper_config to Source
ALTER TABLE "sources" ADD COLUMN "scraper_config" JSONB;

-- Add new fields to IngestRun
ALTER TABLE "ingest_runs" ADD COLUMN "events_unchanged" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ingest_runs" ADD COLUMN "events_ignored" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ingest_runs" ADD COLUMN "merge_stats" JSONB;
ALTER TABLE "ingest_runs" ADD COLUMN "acknowledged_at" TIMESTAMPTZ;

-- Create RawEventItem table
CREATE TABLE "raw_event_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "raw_hash" VARCHAR(64) NOT NULL,
    "raw_payload" JSONB,
    "extracted_fields" JSONB NOT NULL,
    "source_url" VARCHAR(500) NOT NULL,
    "external_id" VARCHAR(255),
    "fingerprint" VARCHAR(32) NOT NULL,
    "parser_version" VARCHAR(20) NOT NULL,
    "normalizer_version" VARCHAR(20) NOT NULL,
    "ai_suggestions" JSONB,
    "canonical_event_id" UUID,
    "ingest_status" VARCHAR(20),
    "ingest_result" JSONB,
    "fetched_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_event_items_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint for source_id + raw_hash
CREATE UNIQUE INDEX "raw_event_items_source_id_raw_hash_key" ON "raw_event_items"("source_id", "raw_hash");

-- Create indexes for RawEventItem
CREATE INDEX "raw_event_items_run_id_idx" ON "raw_event_items"("run_id");
CREATE INDEX "raw_event_items_source_id_fetched_at_idx" ON "raw_event_items"("source_id", "fetched_at");
CREATE INDEX "raw_event_items_fingerprint_idx" ON "raw_event_items"("fingerprint");
CREATE INDEX "raw_event_items_canonical_event_id_idx" ON "raw_event_items"("canonical_event_id");

-- Add foreign keys
ALTER TABLE "raw_event_items" ADD CONSTRAINT "raw_event_items_source_id_fkey" 
    FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "raw_event_items" ADD CONSTRAINT "raw_event_items_run_id_fkey" 
    FOREIGN KEY ("run_id") REFERENCES "ingest_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "raw_event_items" ADD CONSTRAINT "raw_event_items_canonical_event_id_fkey" 
    FOREIGN KEY ("canonical_event_id") REFERENCES "canonical_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
