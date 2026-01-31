-- Update ProviderType enum values
-- Rename existing values to new names and add new values

-- First, rename existing values that have equivalents
ALTER TYPE "ProviderType" RENAME VALUE 'schule' TO 'kita';
ALTER TYPE "ProviderType" RENAME VALUE 'camp' TO 'unternehmen';
ALTER TYPE "ProviderType" RENAME VALUE 'museum' TO 'kommune';
ALTER TYPE "ProviderType" RENAME VALUE 'cafe' TO 'freiberuflich';
ALTER TYPE "ProviderType" RENAME VALUE 'other' TO 'sonstiges';

-- Note: 'verein' remains unchanged
