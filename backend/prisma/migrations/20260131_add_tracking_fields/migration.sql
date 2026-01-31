-- Add tracking fields for deduplication analytics

-- RawEventItem: Add tracking fields
ALTER TABLE raw_event_items 
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS seen_count INT DEFAULT 1;

-- Source: Add HTTP caching fields
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS source_etag VARCHAR(255),
  ADD COLUMN IF NOT EXISTS source_last_modified TIMESTAMPTZ;

-- Update existing records to have sensible defaults
UPDATE raw_event_items 
SET first_seen_at = created_at, 
    last_seen_at = fetched_at
WHERE first_seen_at IS NULL;
