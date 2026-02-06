-- Add field_fill_status to canonical_events (AI field fill tracking)
ALTER TABLE canonical_events
  ADD COLUMN IF NOT EXISTS field_fill_status JSONB DEFAULT '{}';
