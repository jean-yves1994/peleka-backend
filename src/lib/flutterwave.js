/**
 * Flutterwave v4 helper — OAuth (Client ID / Client Secret) flow.
 *
 * v4 differs from v3:
 *   - You DON'T use FLWSECK/FLWPUBK keys. Instead you exchange a
 *     Client ID + Client Secret for a short-lived OAuth access token,
 *     then call the API with `Authorization: Bearer <access_token>`.
 *   - Requests are idempotent via an `X-Idempotency-Key` header.
 *   - Sensitive card fields (not used here — we use hosted checkout) can be
 *     encrypted with the Encryption Key; for hosted "payment links" we don't
 *     need it, so it's optional.
 *
 * Server-side only — none of these secrets reach the app.
 *
 * Env required (see .env.additions):
 *   FLW_CLIENT_ID
 *   FLW_CLIENT_SECRET
 *   FLW_ENCRYPTION_KEY        (optional; only for direct card charge encryption)
 *   FLW_SECRET_HASH           (your own random string; also set in dashboard webhook)
 *   APP_PUBLIC_URL            (public URL of THIS backend, for redirect_url)
 *   FLW_ENV                   'sandbox' | 'live'  (default: sandbox)
 *   # Optional overrides if Flutterwave changes hosts:
 *   FLW_OAUTH_URL
 *   FLW_API_BASE
 */
const crypto = require('crypto');
const { AppError, BadRequestError } = require('./errors');

const CLIENT_ID = process.env.FLW_CLIENT_ID;
const CLIENT_SECRET = process.env.FLW_CLIENT_SECRET;
const SECRET_HASH = process.env.FLW_SECRET_HASH;
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || 'http://localhost:3000';
const FLW_ENV = (process.env.FLW_ENV || 'sandbox').toLowerCase();

// v4 endpoints (overridable via env in case hosts change).
const OAUTH_URL = process.env.FLW_OAUTH_URL ||
  'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
const API_BASE = process.env.FLW_API_BASE ||
  (FLW_ENV === 'live'
    ? 'https://api.flutterwave.cloud/f4b/v1'
    : 'https://api.flutterwave.cloud/developersandbox');

function assertConfigured() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new AppError(
      'Payments not configured (FLW_CLIENT_ID / FLW_CLIENT_SECRET missing)',
      500, 'PAYMENTS_NOT_CONFIGURED',
    );
  }
}

// ---------- OAuth token cache ----------
let _token = null;        // access_token string
let _tokenExpiry = 0;     // epoch ms

async function getAccessToken() {
  assertConfigured();
  const now = Date.now();
  // Reuse cached token until ~30s before expiry.
  if (_token && now < _tokenExpiry - 30_000) return _token;

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new AppError(
      'Flutterwave OAuth failed: ' + (json.error_description || json.error || `HTTP ${res.status}`),
      502, 'FLW_OAUTH_FAILED',
    );
  }
  _token = json.access_token;
  _tokenExpiry = now + (Number(json.expires_in || 600) * 1000);
  return _token;
}

async function authedFetch(path, { method = 'GET', body, idempotencyKey } = {}) {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

/**
 * Create a hosted-checkout payment link (v4 "payment links" / orders).
 * Returns { link, reference } — `reference` is our tx_ref echoed back.
 */
async function createPaymentLink({
  txRef, amount, currency = 'RWF', customer, meta, redirectUrl,
}) {
  assertConfigured();

  // v4 hosted "payment link" payload. Field names align with Flutterwave v4
  // "Create a payment link" (a.k.a. checkout link). Kept minimal + robust.
  const payload = {
    currency,
    amount: Number(amount),
    reference: txRef,
    redirect_url: redirectUrl || `${APP_PUBLIC_URL}/payment-complete`,
    customer: {
      name: customer?.name || 'Peleka Customer',
      email: customer?.email || 'customer@peleka.rw',
      phone_number: customer?.phone || '',
    },
    meta: meta || {},
    customizations: {
      title: 'Peleka Delivery',
      description: meta?.description || 'Delivery payment',
    },
  };

  const { res, json } = await authedFetch('/payment-links', {
    method: 'POST',
    body: payload,
    idempotencyKey: txRef,
  });

  // v4 responses nest the object under `data`; the hosted URL field name has
  // varied by version, so accept the common possibilities.
  const data = json?.data || json || {};
  const link = data.link || data.checkout_url || data.url || data.payment_link;
  if (!res.ok || !link) {
    throw new BadRequestError(
      'Failed to create payment link: ' + (json?.message || json?.error?.message || `HTTP ${res.status}`),
    );
  }
  return { link, reference: data.reference || txRef };
}

/**
 * Verify a transaction. In v4 the webhook gives us a charge/transaction id;
 * we re-fetch it server-side (never trust the payload).
 * Accepts either a transaction id or our reference and returns a normalized
 * object: { status, amount, currency, reference, id, raw }.
 */
async function verifyTransaction({ id, reference }) {
  assertConfigured();
  let path;
  if (id) {
    path = `/charges/${encodeURIComponent(id)}`;
  } else if (reference) {
    path = `/charges?reference=${encodeURIComponent(reference)}`;
  } else {
    throw new BadRequestError('verifyTransaction needs id or reference');
  }

  const { res, json } = await authedFetch(path, { method: 'GET' });
  if (!res.ok) {
    throw new BadRequestError('Verify failed: ' + (json?.message || `HTTP ${res.status}`));
  }

  // Normalize: single object or list.
  let d = json?.data;
  if (Array.isArray(d)) d = d[0];
  d = d || {};

  // v4 status values: 'succeeded' | 'success' | 'failed' | 'pending' ...
  const rawStatus = String(d.status || '').toLowerCase();
  const status = (rawStatus === 'succeeded' || rawStatus === 'success' || rawStatus === 'successful')
    ? 'successful'
    : rawStatus;

  return {
    status,
    amount: Number(d.amount ?? d.charged_amount ?? 0),
    currency: (d.currency || '').toUpperCase(),
    reference: d.reference || reference || null,
    id: d.id || id || null,
    raw: d,
  };
}

/**
 * Validate webhook signature. Flutterwave sends your configured secret hash
 * in the `verif-hash` header. Constant-time compare.
 */
function verifyWebhookSignature(signatureHeader) {
  if (!SECRET_HASH || !signatureHeader) return false;
  const a = Buffer.from(String(signatureHeader));
  const b = Buffer.from(String(SECRET_HASH));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  getAccessToken,       // exported for a quick health check if needed
  createPaymentLink,
  verifyTransaction,
  verifyWebhookSignature,
};
