-- 0019 - Guest shipments
ALTER TABLE shipments ALTER COLUMN customer_id DROP NOT NULL;

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS guest_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(32),
  ADD COLUMN IF NOT EXISTS guest_email CITEXT;

CREATE TABLE IF NOT EXISTS guest_shipment_access (
  shipment_id UUID PRIMARY KEY REFERENCES shipments(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shipments_guest
  ON shipments(is_guest, created_at DESC)
  WHERE is_guest = TRUE;

ALTER TABLE shipments
  ADD CONSTRAINT shipments_guest_contact_check
  CHECK (
    (is_guest = FALSE)
    OR (customer_id IS NULL AND guest_name IS NOT NULL AND guest_phone IS NOT NULL)
  );
