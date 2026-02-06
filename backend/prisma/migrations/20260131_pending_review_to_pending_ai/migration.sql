-- Migration: Add pending_ai status and update existing pending_review events
-- This migration is idempotent

-- Note: The pending_ai enum value was already added via a previous migration
-- This migration just marks the baseline for this specific change
SELECT 1;
