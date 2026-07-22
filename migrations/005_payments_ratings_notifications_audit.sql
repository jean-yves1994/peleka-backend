-- =====================================================================
-- 005 - Payments, ratings, notifications, audit log, complaints
-- =====================================================================

CREATE TABLE IF NOT EXISTS payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id    UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount         NUMERIC(12,2) NOT NULL,
  currency       VARCHAR(8) NOT NULL DEFAULT 'USD',
  method         payment_method NOT NULL,
  status         payment_status NOT NULL DEFAULT 'pending',
  provider       VARCHAR(60),
  provider_ref   VARCHAR(160),
  provider_meta  JSONB NOT NULL DEFAULT '{}'::jsonb,
  paid_at        TIMESTAMPTZ,
  refunded_at    TIMESTAMPTZ,
  failure_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_shipment ON payments(shipment_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ratings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id UUID NOT NULL UNIQUE REFERENCES shipments(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rider_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score       SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ratings_rider ON ratings(rider_id);
DROP TRIGGER IF EXISTS trg_ratings_updated_at ON ratings;
CREATE TRIGGER trg_ratings_updated_at BEFORE UPDATE ON ratings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION update_rider_rating_aggregate()
RETURNS TRIGGER AS $$
DECLARE
  r_id UUID;
BEGIN
  r_id := COALESCE(NEW.rider_id, OLD.rider_id);
  UPDATE rider_profiles rp
  SET rating_avg = COALESCE((SELECT ROUND(AVG(score)::numeric, 2) FROM ratings WHERE rider_id = r_id), 0),
      rating_count = (SELECT COUNT(*) FROM ratings WHERE rider_id = r_id)
  WHERE rp.user_id = r_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_ratings_aggregate ON ratings;
CREATE TRIGGER trg_ratings_aggregate AFTER INSERT OR UPDATE OR DELETE ON ratings
  FOR EACH ROW EXECUTE FUNCTION update_rider_rating_aggregate();

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel    notification_channel NOT NULL DEFAULT 'in_app',
  title      VARCHAR(200) NOT NULL,
  body       TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at    TIMESTAMPTZ,
  sent_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role  user_role,
  action      VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60),
  entity_id   UUID,
  ip_address  INET,
  user_agent  TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor  ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at DESC);

CREATE TABLE IF NOT EXISTS complaints (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id UUID REFERENCES shipments(id) ON DELETE SET NULL,
  raised_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    VARCHAR(60) NOT NULL CHECK (category IN ('failed_pickup','failed_delivery','damage','delay','lost','other')),
  subject     VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','resolved','rejected')),
  resolution  TEXT,
  handled_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_complaints_shipment ON complaints(shipment_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status   ON complaints(status);
DROP TRIGGER IF EXISTS trg_complaints_updated_at ON complaints;
CREATE TRIGGER trg_complaints_updated_at BEFORE UPDATE ON complaints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Contact-info access audit (who fetched rider/customer phone, when)
CREATE TABLE IF NOT EXISTS contact_access_logs (
  id          BIGSERIAL PRIMARY KEY,
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  accessed_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_role  user_role NOT NULL,
  target_role VARCHAR(20) NOT NULL,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_access_shipment
  ON contact_access_logs(shipment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS _migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
