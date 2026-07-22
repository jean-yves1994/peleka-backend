-- =====================================================================
-- 006 - Sync a v1 database up to the full v2 schema
-- Safe to run on either a fresh v2 DB or an existing v1 DB (idempotent).
-- =====================================================================

-- 1) users: email nullable + require (email OR phone) + google_sub column
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_email_or_phone_required') THEN
    ALTER TABLE users
      ADD CONSTRAINT users_email_or_phone_required
      CHECK (email IS NOT NULL OR phone IS NOT NULL);
  END IF;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_sub VARCHAR(64) UNIQUE;

-- 2) rider_profiles: add live-riders index used by admin map
CREATE INDEX IF NOT EXISTS idx_rider_profiles_live
  ON rider_profiles(status, last_location_at DESC)
  WHERE status IN ('online','busy');

-- 3) Phone OTPs table
CREATE TABLE IF NOT EXISTS phone_otps (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        VARCHAR(32) NOT NULL,
  code_hash    TEXT NOT NULL,
  purpose      VARCHAR(20) NOT NULL DEFAULT 'login',
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  ip_address   INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_otps_lookup
  ON phone_otps(phone, consumed_at, expires_at);

-- 4) Complaints: add 'lost' category + attachments column
ALTER TABLE complaints DROP CONSTRAINT IF EXISTS complaints_category_check;
ALTER TABLE complaints
  ADD CONSTRAINT complaints_category_check
  CHECK (category IN ('failed_pickup','failed_delivery','damage','delay','lost','other'));

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 5) Contact access audit log
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