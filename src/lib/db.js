/**
 * PostgreSQL connection pool.
 * Cached on globalThis so Next.js dev mode doesn't leak pools on hot reload.
 * Uses DATABASE_URL (pooled URL on Neon) for runtime queries.
 */
const { Pool } = require('pg');

function createPool() {
  const conn = process.env.DATABASE_URL;
  if (conn) {
    return new Pool({
      connectionString: conn,
      ssl: /sslmode=require/.test(conn) || process.env.PGSSL === 'true'
        ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
    });
  }
  return new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'peleka',
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
  });
}

const g = globalThis;
if (!g.__pelekaPgPool) {
  g.__pelekaPgPool = createPool();
  g.__pelekaPgPool.on('error', (err) => console.error('[pg] idle client error:', err.message));
}
const pool = g.__pelekaPgPool;

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  if (process.env.LOG_SQL === 'true') {
    console.log(`[sql ${Date.now() - start}ms] ${text.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
  return res;
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
