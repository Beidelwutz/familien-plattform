-- PostGIS Location Point Migration
-- Adds a geography point column for efficient geo queries

-- Enable PostGIS extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS postgis;

-- Add location_point column
ALTER TABLE canonical_events 
ADD COLUMN IF NOT EXISTS location_point geography(POINT, 4326);

-- Create spatial index for fast geo queries
CREATE INDEX IF NOT EXISTS canonical_events_location_point_idx 
ON canonical_events USING GIST(location_point);

-- Create function to automatically update location_point from lat/lng
CREATE OR REPLACE FUNCTION update_location_point()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.location_lat IS NOT NULL AND NEW.location_lng IS NOT NULL THEN
    NEW.location_point = ST_SetSRID(ST_MakePoint(
      CAST(NEW.location_lng AS FLOAT), 
      CAST(NEW.location_lat AS FLOAT)
    ), 4326)::geography;
  ELSE
    NEW.location_point = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update location_point
DROP TRIGGER IF EXISTS canonical_events_location_point_trigger ON canonical_events;
CREATE TRIGGER canonical_events_location_point_trigger
  BEFORE INSERT OR UPDATE OF location_lat, location_lng ON canonical_events
  FOR EACH ROW EXECUTE FUNCTION update_location_point();

-- Backfill existing events with location_point
UPDATE canonical_events 
SET location_point = ST_SetSRID(ST_MakePoint(
  CAST(location_lng AS FLOAT), 
  CAST(location_lat AS FLOAT)
), 4326)::geography
WHERE location_lat IS NOT NULL 
  AND location_lng IS NOT NULL 
  AND location_point IS NULL;
