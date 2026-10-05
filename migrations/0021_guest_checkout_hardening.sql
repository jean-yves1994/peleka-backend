-- 0021 - Guest checkout hardening
ALTER TABLE payments ALTER COLUMN customer_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_guest_access_shipment_hash
  ON guest_shipment_access(shipment_id, token_hash);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shipments_guest_customer_consistency'
  ) THEN
    ALTER TABLE shipments
      ADD CONSTRAINT shipments_guest_customer_consistency
      CHECK ((is_guest = TRUE AND customer_id IS NULL) OR (is_guest = FALSE AND customer_id IS NOT NULL));
  END IF;
END $$;
