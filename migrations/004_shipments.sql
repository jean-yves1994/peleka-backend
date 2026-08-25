-- =====================================================================
-- 004 - Shipments, assignments, status history, proofs
-- =====================================================================

CREATE OR REPLACE FUNCTION generate_tracking_number()
RETURNS TEXT AS $$
DECLARE
  code TEXT;
BEGIN
  code := 'PLK-' || to_char(NOW(), 'YYMMDD') || '-' ||
          upper(substr(encode(gen_random_bytes(4),'hex'),1,6));
  RETURN code;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS shipments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_number       VARCHAR(32) UNIQUE NOT NULL DEFAULT generate_tracking_number(),
  customer_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rider_id              UUID REFERENCES users(id) ON DELETE SET NULL,
  status                shipment_status NOT NULL DEFAULT 'awaiting_assignment',
  sender_name           VARCHAR(160) NOT NULL,
  sender_phone          VARCHAR(32)  NOT NULL,
  recipient_name        VARCHAR(160) NOT NULL,
  recipient_phone       VARCHAR(32)  NOT NULL,
  pickup_address        TEXT NOT NULL,
  pickup_city           VARCHAR(120),
  pickup_lat            DOUBLE PRECISION NOT NULL,
  pickup_lng            DOUBLE PRECISION NOT NULL,
  pickup_notes          TEXT,
  pickup_scheduled_at   TIMESTAMPTZ,
  delivery_address      TEXT NOT NULL,
  delivery_city         VARCHAR(120),
  delivery_lat          DOUBLE PRECISION NOT NULL,
  delivery_lng          DOUBLE PRECISION NOT NULL,
  delivery_notes        TEXT,
  delivery_scheduled_at TIMESTAMPTZ,
  requires_signature    BOOLEAN NOT NULL DEFAULT FALSE,
  parcel_description    TEXT NOT NULL,
  parcel_category       VARCHAR(60),
  parcel_weight_kg      NUMERIC(8,2)  NOT NULL DEFAULT 1.00,
  parcel_length_cm      NUMERIC(8,2),
  parcel_width_cm       NUMERIC(8,2),
  parcel_height_cm      NUMERIC(8,2),
  parcel_declared_value NUMERIC(12,2),
  is_fragile            BOOLEAN NOT NULL DEFAULT FALSE,
  pricing_config_id     UUID REFERENCES pricing_configs(id) ON DELETE SET NULL,
  distance_km           NUMERIC(10,2) NOT NULL DEFAULT 0,
  duration_minutes      NUMERIC(10,2) NOT NULL DEFAULT 0,
  base_fare             NUMERIC(12,2) NOT NULL DEFAULT 0,
  distance_fee          NUMERIC(12,2) NOT NULL DEFAULT 0,
  weight_fee            NUMERIC(12,2) NOT NULL DEFAULT 0,
  time_fee              NUMERIC(12,2) NOT NULL DEFAULT 0,
  surge_multiplier      NUMERIC(4,2)  NOT NULL DEFAULT 1.00,
  discount_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_code         VARCHAR(60),
  tax_amount            NUMERIC(12,2) NOT NULL DEFAULT 0,
  subtotal              NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_price           NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency              VARCHAR(8)    NOT NULL DEFAULT 'USD',
  rider_earnings        NUMERIC(12,2) NOT NULL DEFAULT 0,
  assigned_at           TIMESTAMPTZ,
  picked_up_at          TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancellation_reason   TEXT,
  cancelled_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shipments_customer ON shipments(customer_id);
CREATE INDEX IF NOT EXISTS idx_shipments_rider    ON shipments(rider_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status   ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_created  ON shipments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments(tracking_number);

DROP TRIGGER IF EXISTS trg_shipments_updated_at ON shipments;
CREATE TRIGGER trg_shipments_updated_at BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS shipment_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id   UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  rider_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  status        assignment_status NOT NULL DEFAULT 'offered',
  offered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at  TIMESTAMPTZ,
  reject_reason TEXT,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assignments_shipment ON shipment_assignments(shipment_id);
CREATE INDEX IF NOT EXISTS idx_assignments_rider    ON shipment_assignments(rider_id);
CREATE INDEX IF NOT EXISTS idx_assignments_status   ON shipment_assignments(status);
DROP TRIGGER IF EXISTS trg_assignments_updated_at ON shipment_assignments;
CREATE TRIGGER trg_assignments_updated_at BEFORE UPDATE ON shipment_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS shipment_status_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  from_status shipment_status,
  to_status   shipment_status NOT NULL,
  changed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shipment_status_hist ON shipment_status_history(shipment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shipment_proofs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  kind        VARCHAR(20) NOT NULL CHECK (kind IN ('pickup_photo','delivery_photo','signature','id_photo','other')),
  file_url    TEXT NOT NULL,
  file_size   INTEGER,
  mime_type   VARCHAR(80),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_by UUID REFERENCES users(id) ON DELETE SET NULL,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shipment_proofs ON shipment_proofs(shipment_id);

CREATE TABLE IF NOT EXISTS shipment_tracking_pings (
  id          BIGSERIAL PRIMARY KEY,
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  rider_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  heading     NUMERIC(5,2),
  speed_kph   NUMERIC(6,2),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracking_pings_shipment ON shipment_tracking_pings(shipment_id, recorded_at DESC);
