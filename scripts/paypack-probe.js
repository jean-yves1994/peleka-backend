#!/usr/bin/env node
/**
 * paypack-probe.js — verify your Paypack setup in seconds, before touching
 * the app. Run from your peleka-backend-v2 root:
 *
 *   node scripts/paypack-probe.js                    # auth only (safe)
 *   node scripts/paypack-probe.js --phone 0788111222 --amount 100
 *                                                    # real MoMo prompt!
 *   node scripts/paypack-probe.js --find <ref>       # look up a transaction
 *
 * Steps:
 *   1. Credentials present?
 *   2. POST /auth/agents/authorize  → access token
 *   3. (optional) POST /transactions/cashin → pushes a prompt to a phone
 *   4. (optional) GET /transactions/find/{ref}
 *
 * ⚠️  Step 3 triggers a REAL Mobile Money request for the amount you pass.
 *     Use a small amount (e.g. 100 RWF) and your own number.
 */
require('dotenv').config({ path: '.env.local', override: false });
require('dotenv').config();

const crypto = require('crypto');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CLIENT_ID = process.env.PAYPACK_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPACK_CLIENT_SECRET;
const MODE = (process.env.PAYPACK_ENV || 'development').toLowerCase();
const BASE = (process.env.PAYPACK_BASE_URL || 'https://payments.paypack.rw/api').replace(/\/+$/, '');

const PHONE = arg('phone', null);
const AMOUNT = Number(arg('amount', '100'));
const FIND = arg('find', null);

const line = (c = '─') => console.log(c.repeat(66));
const trunc = (s, n = 900) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s, null, 2);
  return t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more chars)` : t;
};
const indent = (s) => trunc(s).split('\n').map((l) => `    ${l}`).join('\n');

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  let local = digits;
  if (digits.startsWith('250')) local = digits.slice(3);
  if (local.length === 9 && local.startsWith('7')) local = `0${local}`;
  return /^07\d{8}$/.test(local) ? local : null;
}

(async () => {
  console.log('');
  line('═');
  console.log(' Paypack probe');
  line('═');

  // ---------- 1. credentials ----------
  console.log('\n[1] Credentials');
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log('  ✗ PAYPACK_CLIENT_ID / PAYPACK_CLIENT_SECRET missing from .env.local');
    console.log('    Create an application at https://payments.paypack.rw → Applications');
    process.exit(1);
  }
  if (/your_client|xxxx/i.test(CLIENT_SECRET)) {
    console.log('  ✗ PAYPACK_CLIENT_SECRET still holds the placeholder value.');
    process.exit(1);
  }
  console.log(`  ✓ client_id     ${CLIENT_ID.slice(0, 8)}…`);
  console.log(`  ✓ client_secret ${'*'.repeat(8)} (len ${CLIENT_SECRET.length})`);
  console.log(`  · base url      ${BASE}`);
  console.log(`  · webhook mode  ${MODE}`);

  // ---------- 2. authorize ----------
  console.log('\n[2] Authorize  (POST /auth/agents/authorize)');
  let token = null;
  try {
    const res = await fetch(`${BASE}/auth/agents/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    console.log(`  HTTP ${res.status}`);
    if (res.ok && json && json.access) {
      token = json.access;
      console.log(`  ✓ access token received (len ${token.length})`);
      if (json.refresh) console.log(`  ✓ refresh token received`);
      if (json.expires) console.log(`  · expires: ${json.expires}`);
    } else {
      console.log('  ✗ no access token. Raw response:');
      console.log(indent(json));
      console.log('\n  → 401/403: wrong client_id/secret, or the application was deleted.');
      console.log('    404: base URL wrong. 000/ECONNRESET: host unreachable.');
    }
  } catch (e) {
    console.log(`  ✗ request failed: ${e.message}`);
    if (e.cause) console.log(`    cause: ${e.cause.code || e.cause.message}`);
  }

  if (!token) {
    line();
    console.log('\nStopping — fix authorization first.\n');
    process.exit(1);
  }

  const authed = (path, init = {}) => fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Webhook-Mode': MODE,
      ...(init.headers || {}),
    },
  });

  // ---------- 4. find (if asked) ----------
  if (FIND) {
    console.log(`\n[3] Find transaction  (GET /transactions/find/${FIND})`);
    try {
      const res = await authed(`/transactions/find/${encodeURIComponent(FIND)}`);
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      console.log(`  HTTP ${res.status}`);
      console.log(indent(json));
    } catch (e) {
      console.log(`  ✗ ${e.message}`);
    }
    line();
    console.log('');
    process.exit(0);
  }

  // ---------- 3. cashin (only if a phone was supplied) ----------
  if (!PHONE) {
    line();
    console.log('\n✓ Auth works. Paypack credentials and base URL are correct.');
    console.log('\nTo test a real Mobile Money prompt (small amount, your own number):');
    console.log('  node scripts/paypack-probe.js --phone 0788111222 --amount 100');
    console.log('');
    process.exit(0);
  }

  const number = normalizePhone(PHONE);
  if (!number) {
    console.log(`\n✗ "${PHONE}" is not a valid Rwandan mobile number.`);
    console.log('  Use e.g. 0788111222 or +250788111222');
    process.exit(1);
  }

  console.log('\n[3] Cash-in  (POST /transactions/cashin)');
  console.log(`  ⚠️  Sending a REAL request for RWF ${AMOUNT} to ${number}`);
  const idem = `probe${crypto.randomBytes(10).toString('hex')}`.slice(0, 32);
  let ref = null;
  try {
    const res = await authed('/transactions/cashin', {
      method: 'POST',
      headers: { 'Idempotency-Key': idem },
      body: JSON.stringify({ amount: AMOUNT, number }),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    console.log(`  HTTP ${res.status}`);
    console.log(indent(json));
    if (res.ok && json && json.ref) {
      ref = json.ref;
      console.log(`\n  ✓ Request accepted — ref ${ref}, status "${json.status}"`);
      console.log('  → Approve the prompt on the phone, then run:');
      console.log(`     node scripts/paypack-probe.js --find ${ref}`);
    } else {
      console.log('\n  ✗ Cash-in was rejected. Common causes:');
      console.log('    • application lacks "cashin" privilege → recreate it with cashin rights');
      console.log('    • amount below the provider minimum');
      console.log('    • number not on a supported carrier');
    }
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
  }

  line();
  console.log('');
})().catch((e) => { console.error(e); process.exit(1); });
