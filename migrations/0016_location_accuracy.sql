-- Location accuracy hardening.
-- Add metadata without changing existing known_locations coordinates.

ALTER TABLE known_locations
  ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS location_type TEXT NOT NULL DEFAULT 'landmark',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS accuracy_meters NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS country_code TEXT NOT NULL DEFAULT 'RW';

CREATE INDEX IF NOT EXISTS idx_known_locations_active ON known_locations (is_active);
CREATE INDEX IF NOT EXISTS idx_known_locations_aliases_gin ON known_locations USING GIN (aliases);

-- Existing records are Rwanda locations. Keep the migration conservative: aliases
-- can be populated/administered later without inventing names that are not known.
UPDATE known_locations
   SET country_code = 'RW'
 WHERE country_code IS NULL OR country_code = '';
