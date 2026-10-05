-- 0018 - Multi-role customer capability
-- A rider remains a rider while a customer_profiles row grants customer capability.
CREATE INDEX IF NOT EXISTS idx_customer_profiles_user_id ON customer_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_rider_profiles_user_id ON rider_profiles(user_id);
