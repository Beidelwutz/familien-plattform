-- Initialize PostGIS extension and add location point columns
-- This runs on database initialization

-- Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- Add geometry column to canonical_events after Prisma creates the table
-- (Prisma doesn't fully support PostGIS, so we add this manually)

-- Note: This SQL will be run after the initial Prisma migration
-- The column will be added via a separate migration file
