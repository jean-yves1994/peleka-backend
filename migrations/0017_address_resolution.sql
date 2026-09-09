CREATE TABLE IF NOT EXISTS address_resolutions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NULL,
  shipment_id BIGINT NULL,
  location_type TEXT NOT NULL CHECK (location_type IN ('pickup', 'delivery')),
  input_text TEXT NOT NULL,
  normalized_text TEXT,
  selected_name TEXT,
  formatted_address TEXT,
  latitude NUMERIC(10,7) NOT NULL,
  longitude NUMERIC(10,7) NOT NULL,
  accuracy_meters NUMERIC(8,2),
  source TEXT NOT NULL,
  provider TEXT,
  provider_place_id TEXT,
  known_location_id BIGINT NULL,
  confidence NUMERIC(5,4),
  confirmed_by_user BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_address_resolutions_shipment
  ON address_resolutions (shipment_id, location_type);

CREATE INDEX IF NOT EXISTS idx_address_resolutions_user
  ON address_resolutions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_address_resolutions_provider_place
  ON address_resolutions (provider, provider_place_id);
