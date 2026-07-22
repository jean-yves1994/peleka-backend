#!/usr/bin/env node
/**
 * Idempotently seeds a bootstrap admin and a default active pricing config.
 * Uses DIRECT_URL if set (recommended for Neon).
 */
require('dotenv').config({ path: '.env.local', override: false });
require('dotenv').config();

const bcrypt = require('bcrypt');
const { Client } = require('pg');

function buildClient() {
  const conn = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (conn) return new Client({
    connectionString: conn,
    ssl: /sslmode=require/.test(conn) || process.env.PGSSL === 'true'
      ? { rejectUnauthorized: false } : undefined,
  });
  return new Client({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'peleka',
  });
}

async function main() {
  const client = buildClient();
  await client.connect();
  try {
    const email    = process.env.BOOTSTRAP_ADMIN_EMAIL    || 'admin@peleka.local';
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'ChangeMe!123';
    const name     = process.env.BOOTSTRAP_ADMIN_NAME     || 'Peleka Admin';
    const hash     = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS || 12));

    const admin = await client.query(
      `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
       VALUES ($1,$2,$3,'admin','active',NOW())
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id, email`,
      [email, hash, name]
    );
    console.log(`✓ Admin ready: ${admin.rows[0].email}`);

    const existing = await client.query(`SELECT id FROM pricing_configs WHERE is_active = TRUE LIMIT 1`);
    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO pricing_configs
          (name, currency, base_fare, price_per_km, price_per_kg, min_price,
           surge_multiplier, tax_percentage, rider_commission_percentage, is_active, created_by)
         VALUES ('Default Pricing','USD',2.00,0.80,0.20,3.00,1.00,0.00,70.00,TRUE,$1)`,
        [admin.rows[0].id]
      );
      console.log('✓ Default pricing config created');
    } else {
      console.log('✓ Pricing config already exists');
    }
    console.log('✅ Seed complete');
  } finally {
    await client.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
