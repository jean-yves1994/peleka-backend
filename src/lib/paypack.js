/**
 * Paypack helper — server-side only.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIX (verified against your live account via /api/admin/paypack-probe)
 *
 * `/transactions/find/{ref}` returns HTTP 200 and the transaction — but the
 * response has NO `status` field:
 *
 *   { ref, amount, fee, kind, provider, client, metadata, merchant, timestamp }
 *
 * The old findTransaction() read `d.status`, got `undefined`, and
 * normalizeStatus() fell through to 'pending'. So every lookup reported
 * "pending" for payments that had actually succeeded — no error, no 404,
 * nothing in the logs. That is why confirmed payments never marked shipments
 * as paid.
 *
 * The status lives in the EVENTS feed instead:
 *
 *   GET /events/transactions?ref={ref}
 *   → { ref, limit, total, transactions: [
 *         { event_kind: "transaction:processed",
 *           data: { ref, status: "successful", amount, ... } },
 *         { event_kind: "transaction:created",
 *           data: { ref, status: "pending", amount, ... } }
 *       ] }
 *
 * findTransaction() now reads the events feed and falls back to
 * /transactions/find/{ref} only to confirm existence.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Env:
 *   PAYPACK_CLIENT_ID
 *   PAYPACK_CLIENT_SECRET
 *   PAYPACK_WEBHOOK_SECRET
 *   PAYPACK_ENV           'development' | 'production'
 *   PAYPACK_BASE_URL      optional override
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
// Access tokens are short-lived. Cache and refresh slightly early; a single
// in-flight promise prevents a burst of concurrent authorize calls.
let _access = null;
let _refresh = null;
let _expiresAt = 0;
let _inflight = null;

function setTokens(json) {
  _access = json.access || null;
  _refresh = json.refresh || null;
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
    status: normalizeStatus(json.status),
    amount: Number(json.amount ?? amt),
    raw: json,
  };
}

/**
 * Look up a transaction and determine whether it succeeded.
 *
 * Reads the EVENTS feed, because that is the only place Paypack exposes a
 * status. `/transactions/find/{ref}` confirms a transaction exists and gives
 * the amount, but carries no status at all.
 *
 * @returns {Promise<{status:'successful'|'failed'|'pending',amount:number,ref:string,raw:object}>}
 */
async function findTransaction(ref) {
  assertConfigured();
  const encoded = encodeURIComponent(ref);

  // 1) Events feed — carries the status.
  const ev = await authedFetch(`/events/transactions?ref=${encoded}`);
  const events = Array.isArray(ev.json?.transactions) ? ev.json.transactions : [];

  if (ev.res.ok && events.length) {
    // A terminal 'processed' event is authoritative. Otherwise take the most
    // recent event. Don't rely on the array's ordering — sort explicitly.
    const sorted = [...events].sort(
      (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
    );
    const processed = sorted.find((e) =>
      String(e.event_kind || '').toLowerCase().includes('processed'),
    );
    const chosen = processed || sorted[0];
    const d = chosen.data || {};

    return {
      status: normalizeStatus(d.status),
      amount: Number(d.amount ?? 0),
      ref: d.ref || ref,
      raw: { event_kind: chosen.event_kind, ...d },
    };
  }

  // 2) No events yet — confirm the transaction exists at all. This endpoint
  //    has no status field, so anything found here is still in flight.
  const found = await authedFetch(`/transactions/find/${encoded}`);
  if (found.res.ok && found.json?.ref) {
    return {
      status: 'pending',
      amount: Number(found.json.amount ?? 0),
      ref: found.json.ref,
      raw: found.json,
    };
  }

  throw new BadRequestError(
    `Transaction ${ref} not found (events HTTP ${ev.res.status}, find HTTP ${found.res.status})`,
  );
}

function normalizeStatus(s) {
  const v = String(s || '').toLowerCase();
  if (['successful', 'success', 'succeeded', 'completed', 'processed'].includes(v)) {
    return 'successful';
  }
  if (['failed', 'failure', 'cancelled', 'canceled', 'rejected', 'expired'].includes(v)) {
    return 'failed';
  }
  return 'pending';
}

/**
 * Verify a webhook's HMAC-SHA256 signature.
 *
 * Paypack signs the raw request body with your webhook secret. Header naming
 * has varied, so accept the common variants and compare both hex and base64
 * digests in constant time.
 *
 * @param {string} rawBody  the EXACT raw request body string
 * @param {Headers} headers
 */
function verifyWebhookSignature(rawBody, headers) {
  if (!WEBHOOK_SECRET) return false;
  const provided =
    headers.get('x-paypack-signature') ||
    headers.get('paypack-signature') ||
    headers.get('x-signature') ||
    headers.get('signature');
  if (!provided) return false;

  const hex = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody || '', 'utf8')
    .digest('hex');
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
  getAccessToken,
  cashin,
  findTransaction,
  verifyWebhookSignature,
  normalizePhone,
  normalizeStatus,
};
