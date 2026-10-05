-- Allow a payment to belong to a guest shipment without a user account.
ALTER TABLE payments ALTER COLUMN customer_id DROP NOT NULL;
