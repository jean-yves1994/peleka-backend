-- =====================================================================
-- 003 - Pricing rules (admin configurable)
-- =====================================================================

CREATE TABLE IF NOT EXISTS pricing_configs (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        VARCHAR(120) NOT NULL,
  currency                    VARCHAR(8) NOT NULL DEFAULT 'USD',
  base_fare                   NUMERIC(12,2) NOT NULL DEFAULT 2.00,
  price_per_km                NUMERIC(12,2) NOT NULL DEFAULT 0.80,
  price_per_kg                NUMERIC(12,2) NOT NULL DEFAULT 0.20,
  price_per_minute            NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  min_price                   NUMERIC(12,2) NOT NULL DEFAULT 3.00,
  max_price                   NUMERIC(12,2),
  free_km                     NUMERIC(6,2)  NOT NULL DEFAULT 0,
  surge_multiplier            NUMERIC(4,2)  NOT NULL DEFAULT 1.00,
  tax_percentage              NUMERIC(5,2)  NOT NULL DEFAULT 0.00,
  rider_commission_percentage NUMERIC(5,2)  NOT NULL DEFAULT 70.00,
  is_active                   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_configs_active
  ON pricing_configs ((TRUE)) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_pricing_configs_updated_at ON pricing_configs;
CREATE TRIGGER trg_pricing_configs_updated_at BEFORE UPDATE ON pricing_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS route_prices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_city      VARCHAR(120) NOT NULL,
  destination_city VARCHAR(120) NOT NULL,
  flat_price       NUMERIC(12,2) NOT NULL,
  currency         VARCHAR(8) NOT NULL DEFAULT 'USD',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (origin_city, destination_city)
);
DROP TRIGGER IF EXISTS trg_route_prices_updated_at ON route_prices;
CREATE TRIGGER trg_route_prices_updated_at BEFORE UPDATE ON route_prices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS discounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(60) UNIQUE NOT NULL,
  description   TEXT,
  discount_type VARCHAR(20) NOT NULL CHECK (discount_type IN ('percent','fixed')),
  amount        NUMERIC(12,2) NOT NULL,
  max_uses      INTEGER,
  used_count    INTEGER NOT NULL DEFAULT 0,
  valid_from    TIMESTAMPTZ,
  valid_to      TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_discounts_updated_at ON discounts;
CREATE TRIGGER trg_discounts_updated_at BEFORE UPDATE ON discounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
