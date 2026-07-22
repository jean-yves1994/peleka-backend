-- =====================================================================
-- 002 - Users, auth sessions, password resets, device tokens
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             CITEXT UNIQUE,
  phone             VARCHAR(32) UNIQUE,
  password_hash     TEXT NOT NULL,
  full_name         VARCHAR(160) NOT NULL,
  role              user_role NOT NULL DEFAULT 'customer',
  status            user_status NOT NULL DEFAULT 'active',
  email_verified_at TIMESTAMPTZ,
  phone_verified_at TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  avatar_url        TEXT,
  google_sub        VARCHAR(64) UNIQUE,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS customer_profiles (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_address TEXT,
  default_lat     DOUBLE PRECISION,
  default_lng     DOUBLE PRECISION,
  wallet_balance  NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_customer_profiles_updated_at ON customer_profiles;
CREATE TRIGGER trg_customer_profiles_updated_at BEFORE UPDATE ON customer_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS rider_profiles (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status           rider_status NOT NULL DEFAULT 'pending_approval',
  vehicle_type     VARCHAR(40)  NOT NULL DEFAULT 'motorcycle',
  vehicle_plate    VARCHAR(32),
  license_number   VARCHAR(64),
  national_id      VARCHAR(64),
  documents        JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_lat      DOUBLE PRECISION,
  current_lng      DOUBLE PRECISION,
  last_location_at TIMESTAMPTZ,
  rating_avg       NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count     INTEGER NOT NULL DEFAULT 0,
  completed_jobs   INTEGER NOT NULL DEFAULT 0,
  approved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rider_profiles_status   ON rider_profiles(status);
CREATE INDEX IF NOT EXISTS idx_rider_profiles_location ON rider_profiles(current_lat, current_lng);
CREATE INDEX IF NOT EXISTS idx_rider_profiles_live
  ON rider_profiles(status, last_location_at DESC)
  WHERE status IN ('online','busy');
DROP TRIGGER IF EXISTS trg_rider_profiles_updated_at ON rider_profiles;
CREATE TRIGGER trg_rider_profiles_updated_at BEFORE UPDATE ON rider_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  user_agent  TEXT,
  ip_address  INET,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry ON refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS password_resets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

CREATE TABLE IF NOT EXISTS device_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   VARCHAR(20) NOT NULL,
  token      TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, token)
);
DROP TRIGGER IF EXISTS trg_device_tokens_updated_at ON device_tokens;
CREATE TRIGGER trg_device_tokens_updated_at BEFORE UPDATE ON device_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Phone OTPs for phone-based login/signup
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
