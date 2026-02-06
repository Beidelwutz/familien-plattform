CREATE INDEX IF NOT EXISTS "canonical_events_availability_status_idx" ON "canonical_events"("availability_status");
CREATE INDEX IF NOT EXISTS "canonical_events_parent_series_id_idx" ON "canonical_events"("parent_series_id");
CREATE INDEX IF NOT EXISTS "canonical_events_city_idx" ON "canonical_events"("city");
