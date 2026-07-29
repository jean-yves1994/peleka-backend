/**
 * Paypack helper — server-side only.
 *
 * Paypack is a Rwandan payment platform supporting MTN Mobile Money,
 * Airtel Money and Tigo Cash. It uses a "Request to Pay" model: we push a
 * charge request to the customer's phone, they approve with their MoMo PIN,
 * and Paypack notifies us via webhook.
 *
 * VERIFIED against https://docs.paypack.rw :
 *   Base URL      https://payments.paypack.rw/api
 *   Authorize     POST ${BASE}/auth/agents/authorize   { client_id, client_secret }
 *                 → { access, refresh, expires }       (access lasts ~15 min)
 *   Refresh       GET  ${BASE}/auth/agents/refresh/{refresh_token}
 *   Cashin        POST ${BASE}/transactions/cashin      { amount:number, number:string }
 *                 → { amount, created_at, kind:"CASHIN", ref, status:"pending" }
 *   Find tx       GET  ${BASE}/transactions/find/{ref}
 *   Idempotency   `Idempotency-Key` header, max 32 chars (optional)
 *   Webhook mode  `X-Webhook-Mode` header ("development" | "production")
 *
 * Env (see .env.additions):
 *   PAYPACK_CLIENT_ID
 *   PAYPACK_CLIENT_SECRET
 *   PAYPACK_WEBHOOK_SECRET      used to verify the HMAC-SHA256 signature
 *   PAYPACK_ENV                 'development' | 'production' (default: development)
 *   PAYPACK_BASE_URL            optional override
 */
const crypto = require('crypto');
const { AppError, BadRequestError } = require('./errors');

const CLIENT_ID = process.env.PAYPACK_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPACK_CLIENT_SECRET;
const WEBHOOK_SECRET = process.env.PAYPACK_WEBHOOK_SECRET;
const WEBHOOK_MODE = (process.env.PAYPACK_ENV || 'development').toLowerCase();
const BASE = (process.env.PAYPACK_BASE_URL || 'https://payments.paypack.rw/api')
  .replace(/\/+$/, '');

function assertConfigured() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new AppError(
      'Payments not configured (PAYPACK_CLIENT_ID / PAYPACK_CLIENT_SECRET missing)',
      500,
      'PAYMENTS_NOT_CONFIGURED',
    );
  }
}

// ---------- token cache ----------
// Access tokens last ~15 minutes. Cache and refresh slightly early. A single
// in-flight promise prevents a thundering herd of authorize calls.
let _access = null;
let _refresh = null;
let _expiresAt = 0; // epoch ms
let _inflight = null;

function setTokens(json) {
  _access = json.access || null;
  _refresh = json.refresh || null;
  // `expires` may be seconds-from-now or an absolute value depending on
  // account; treat small numbers as a TTL and fall back to 14 minutes.
  const raw = Number(json.expires);
  const ttlSec = Number.isFinite(raw) && raw > 0 && raw < 86400 ? raw : 840;
  _expiresAt = Date.now() + ttlSec * 1000;
  return _access;
}

async function authorize() {
  assertConfigured();
  const res = await fetch(`${BASE}/auth/agents/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access) {
    throw new AppError(
      'Paypack authorize failed: ' + (json.message || json.error || `HTTP ${res.status}`),
      502,
      'PAYPACK_AUTH_FAILED',
    );
  }
  return setTokens(json);
}

async function refreshAccess() {
  if (!_refresh) return authorize();
  const res = await fetch(`${BASE}/auth/agents/refresh/${encodeURIComponent(_refresh)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access) return authorize(); // refresh expired → full login
  return setTokens(json);
}

async function getAccessToken() {
  if (_access && Date.now() < _expiresAt - 30_000) return _access;
  if (_inflight) return _inflight;
  _inflight = (_refresh ? refreshAccess() : authorize()).finally(() => {
    _inflight = null;
  });
  return _inflight;
}

async function authedFetch(path, { method = 'GET', body, idempotencyKey } = {}) {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Webhook-Mode': WEBHOOK_MODE,
  };
  // Paypack caps the key at 32 characters.
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 32);

  let res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // One retry on 401 in case the token expired mid-flight.
  if (res.status === 401) {
    _access = null;
    const fresh = await getAccessToken();
    headers.Authorization = `Bearer ${fresh}`;
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  const json = await res.json().catch(() => ({}));
  return { res, json };
}

/**
 * Normalise a Rwandan MSISDN to the local 07XXXXXXXX form Paypack expects.
 *   +250788111222 / 250788111222 / 0788111222 / 788111222 → 0788111222
 */
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  let local = digits;
  if (digits.startsWith('250')) local = digits.slice(3);
  if (local.length === 9 && local.startsWith('7')) local = `0${local}`;
  if (!/^07\d{8}$/.test(local)) {
    throw new BadRequestError(
      'Enter a valid Rwandan mobile number, e.g. 0788111222 or +250788111222',
    );
  }
  return local;
}

/**
 * Push a Mobile Money charge to the customer's phone.
 * @returns {Promise<{ref:string,status:string,amount:number,raw:object}>}
 */
async function cashin({ amount, phone, idempotencyKey }) {
  assertConfigured();
  const number = normalizePhone(phone);
  // RWF has no decimal subunit in practice — send a whole number.
  const amt = Math.round(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new BadRequestError('Invalid payment amount');
  }

  const { res, json } = await authedFetch('/transactions/cashin', {
    method: 'POST',
    body: { amount: amt, number },
    idempotencyKey,
  });

  if (!res.ok || !json.ref) {
    throw new BadRequestError(
      'Failed to request payment: ' + (json.message || json.error || `HTTP ${res.status}`),
    );
  }
  return {
    ref: json.ref,
    status: String(json.status || 'pending').toLowerCase(),
    amount: Number(json.amount ?? amt),
    raw: json,
  };
}

/**
 * Look up a transaction by its Paypack ref.
 * Normalises status to: 'successful' | 'failed' | 'pending'
 */
async function findTransaction(ref) {
  assertConfigured();
  const { res, json } = await authedFetch(`/transactions/find/${encodeURIComponent(ref)}`);
  if (!res.ok) {
    throw new BadRequestError('Verify failed: ' + (json.message || `HTTP ${res.status}`));
  }
  const d = json?.data || json || {};
  return {
    status: normalizeStatus(d.status),
    amount: Number(d.amount ?? 0),
    ref: d.ref || ref,
    raw: d,
  };
}

function normalizeStatus(s) {
  const v = String(s || '').toLowerCase();
  if (['successful', 'success', 'succeeded', 'completed', 'processed'].includes(v)) {
    return 'successful';
  }
  if (['failed', 'failure', 'cancelled', 'canceled', 'rejected'].includes(v)) return 'failed';
  return 'pending';
}

/**
 * Verify a webhook's HMAC-SHA256 signature.
 *
 * Paypack signs the raw request body with your webhook secret and sends the
 * digest in a signature header. Header naming has varied, so we accept the
 * common variants and compare both hex and base64 digests in constant time.
 *
 * @param {string} rawBody  the EXACT raw request body string
 * @param {Headers} headers  the request headers
 */
function verifyWebhookSignature(rawBody, headers) {
  if (!WEBHOOK_SECRET) return false;
  const provided =
    headers.get('x-paypack-signature') ||
    headers.get('paypack-signature') ||
    headers.get('x-signature') ||
    headers.get('signature');
  if (!provided) return false;

  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody || '', 'utf8');
  const hex = hmac.digest('hex');
  const b64 = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody || '', 'utf8')
    .digest('base64');

  const clean = String(provided).replace(/^sha256=/i, '').trim();
  return safeEqual(clean, hex) || safeEqual(clean, b64);
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

module.exports = {
  getAccessToken, // exported for the probe / health check
  cashin,
  findTransaction,
  verifyWebhookSignature,
  normalizePhone,
  normalizeStatus,
};
