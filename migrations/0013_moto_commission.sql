-- ============================================================================
-- 0013 · Motorbike commission
-- ============================================================================
-- Safe to re-run.
--
-- Adds one column to pricing_configs, matching the naming already in the table:
--
--     rider_commission_percentage   70.00   (exists)
--     moto_commission_percentage    ??      (new)
--     Peleka                        remainder = 100 − rider − moto
--
-- Both are the share that party RECEIVES, consistent with your existing
-- rider_commission_percentage default of 70.00.
--
-- Riders in Kigali frequently ride a motorbike they don't own, so the fare
-- splits three ways rather than two.
--
-- Defaults to 0, so behaviour is identical to today until you set a real
-- number. Safe to apply before deciding on one.
-- ============================================================================

BEGIN;

ALTER TABLE pricing_configs
  ADD COLUMN IF NOT EXISTS moto_commission_percentage NUMERIC(5,2) NOT NULL DEFAULT 0.00;

-- The two shares can't exceed the fare. Without this, a typo (70 + 40) would
-- promise more than was collected, and you'd only discover it at payout.
DO $$
BEGIN
  ALTER TABLE pricing_configs
    ADD CONSTRAINT pricing_configs_commission_valid
    CHECK (
      rider_commission_percentage >= 0
      AND moto_commission_percentage >= 0
      AND (rider_commission_percentage + moto_commission_percentage) <= 100
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── Frozen per shipment ─────────────────────────────────────────────────────
-- The split is recorded on each shipment at creation, so changing the config
-- later can't rewrite what a rider or moto owner was already owed.

ALTER TABLE shipments ADD COLUMN IF NOT EXISTS moto_earnings     NUMERIC(12,2);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS platform_earnings NUMERIC(12,2);
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS rider_commission_percentage NUMERIC(5,2);
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS moto_commission_percentage  NUMERIC(5,2);

-- Historical shipments had no moto share, so all non-rider money was Peleka's.
UPDATE shipments
   SET moto_earnings     = COALESCE(moto_earnings, 0),
       platform_earnings = COALESCE(
         platform_earnings,
         GREATEST(0, COALESCE(total_price, 0) - COALESCE(rider_earnings, 0))
       )
 WHERE moto_earnings IS NULL OR platform_earnings IS NULL;

COMMIT;

-- ============================================================================
-- Verify
-- ============================================================================
-- SELECT name,
--        rider_commission_percentage,
--        moto_commission_percentage,
--        100 - rider_commission_percentage - moto_commission_percentage AS platform_pct
--   FROM pricing_configs
--  ORDER BY is_active DESC;
