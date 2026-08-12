-- ============================================================================
-- 0014 · Contract customers
-- ============================================================================
-- Safe to re-run.
--
-- A contract customer's shipments dispatch to riders immediately without
-- payment, and are billed later on an invoice.
--
--   contract_customer    false → pay before dispatch (everyone, by default)
--   credit_limit         ceiling on unbilled work. 0 = no limit
--   outstanding_balance  what they currently owe
--
-- `outstanding_balance` is maintained in the shipment-creation transaction, so
-- the credit check and the balance update can't drift apart.
-- ============================================================================

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS contract_customer BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS outstanding_balance NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Neither figure can go negative — a refund bug shouldn't be able to hand
-- someone unlimited credit.
DO $$
BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_credit_nonneg
    CHECK (credit_limit >= 0 AND outstanding_balance >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS users_contract_idx
  ON users (contract_customer) WHERE contract_customer;

COMMIT;

