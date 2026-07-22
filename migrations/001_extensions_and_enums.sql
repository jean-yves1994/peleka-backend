-- =====================================================================
-- 001 - Extensions, enums, and shared utility functions
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('customer', 'rider', 'admin', 'dispatcher');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('pending', 'active', 'suspended', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rider_status AS ENUM ('pending_approval', 'approved', 'suspended', 'offline', 'online', 'busy');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE shipment_status AS ENUM (
    'draft', 'pending_payment', 'awaiting_assignment', 'assigned',
    'rider_en_route_to_pickup', 'picked_up', 'in_transit',
    'out_for_delivery', 'delivered', 'failed_pickup', 'failed_delivery',
    'returned', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE assignment_status AS ENUM ('offered', 'accepted', 'rejected', 'expired', 'cancelled', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'authorized', 'paid', 'failed', 'refunded', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('cash', 'card', 'mobile_money', 'wallet', 'bank_transfer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_channel AS ENUM ('push', 'sms', 'email', 'in_app');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
