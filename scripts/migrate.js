#!/usr/bin/env node
/**
 * Forward-only SQL migration runner.
 * Uses DIRECT_URL if set (recommended for pooled Postgres like Neon),
 * otherwise falls back to DATABASE_URL / discrete PG* vars.
 */
require('dotenv').config({ path: '.env.local', override: false });
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function buildClient() {
  const conn = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (conn) {
    return new Client({
      connectionString: conn,
      ssl: /sslmode=require/.test(conn) || process.env.PGSSL === 'true'
        ? { rejectUnauthorized: false } : undefined,
    });
  }
  return new Client({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'peleka',
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
}

async function up() {
  const client = buildClient();
  await client.connect();
  console.log('▶︎  Connected to PostgreSQL');
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const { rows } = await client.query('SELECT filename FROM _migrations');
    const applied = new Set(rows.map(r => r.filename));

    for (const file of files) {
      if (applied.has(file)) { console.log(`✓  Skipping ${file}`); continue; }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`→  Applying ${file}...`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`✓  Applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`✗  Failed on ${file}:`, err.message);
        throw err;
      }
    }
    console.log('✅  Migrations complete');
  } finally {
    await client.end();
  }
}

up().catch(err => { console.error(err); process.exit(1); });
