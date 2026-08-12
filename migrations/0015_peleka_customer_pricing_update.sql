-- ============================================================================
-- 0015 · Peleka customer/payout workflow update
--
-- Adds the explicit standard/premier customer type while keeping the older
-- contract_customer flag for backwards compatibility.
-- Makes pricing distance-only at the application level (legacy columns remain
-- physically present so old databases/data can be upgraded safely).
-- ============================================================================
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS customer_type VARCHAR(20) NOT NULL DEFAULT 'standard';

DO $$
BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_customer_type_check
    CHECK (customer_type IN ('standard','premier'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Existing contract customers are Premier customers.
UPDATE users
   SET customer_type = 'premier'
 WHERE contract_customer = TRUE
   AND customer_type <> 'premier';

CREATE INDEX IF NOT EXISTS idx_users_customer_type
  ON users(customer_type) WHERE role = 'customer' AND deleted_at IS NULL;

-- Weight/free-km are no longer part of pricing. Keep the columns for backwards
-- compatibility with existing rows and receipts, but neutralise them.
UPDATE pricing_configs
   SET price_per_kg = 0,
       free_km = 0
 WHERE price_per_kg <> 0 OR free_km <> 0;

COMMIT;
