-- =====================================================================
-- 007 — Kigali RWF pricing configuration
--
-- Replaces the seeded USD "Default Pricing" config with a Kigali RWF one:
--   base_fare     500 RWF   flat dispatch fee
--   price_per_km  200 RWF
--   price_per_kg   50 RWF
--   min_price   1,000 RWF   floor for very short hops
--   tax            18 %     Rwanda VAT
--   commission     70 %     rider's share of the pre-tax subtotal
--
-- Fully idempotent: safe to run repeatedly, and guarantees exactly ONE
-- active config afterwards.
-- =====================================================================

-- 1) Stand down every currently-active config.
UPDATE pricing_configs SET is_active = FALSE WHERE is_active = TRUE;

-- 2) Insert the Kigali config only if it isn't there already.
--    (Uses NOT EXISTS instead of ON CONFLICT because `name` has no unique
--     constraint — ON CONFLICT DO NOTHING would happily create duplicates
--     on a second run.)
INSERT INTO pricing_configs (
  name, currency,
  base_fare, price_per_km, price_per_kg, price_per_minute,
  min_price, max_price, free_km,
  surge_multiplier, tax_percentage, rider_commission_percentage,
  is_active
)
SELECT
  'Kigali Standard (RWF)', 'RWF',
  500, 200, 50, 0,
  1000, NULL, 0,
  1.00, 18.00, 70.00,
  FALSE
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_configs WHERE name = 'Kigali Standard (RWF)'
);

-- 3) Force the correct rates (in case an older/partial row already existed).
UPDATE pricing_configs SET
  currency                    = 'RWF',
  base_fare                   = 500,
  price_per_km                = 200,
  price_per_kg                = 50,
  price_per_minute            = 0,
  min_price                   = 1000,
  free_km                     = 0,
  surge_multiplier            = 1.00,
  tax_percentage              = 18.00,
  rider_commission_percentage = 70.00,
  updated_at                  = NOW()
WHERE name = 'Kigali Standard (RWF)';

-- 4) Activate exactly one row (the newest), so we can never end up with
--    two active configs even if duplicates exist from an earlier attempt.
UPDATE pricing_configs SET is_active = TRUE
WHERE id = (
  SELECT id FROM pricing_configs
   WHERE name = 'Kigali Standard (RWF)'
   ORDER BY created_at DESC
   LIMIT 1
);
