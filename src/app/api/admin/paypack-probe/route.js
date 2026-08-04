/**
 * GET /api/admin/paypack-probe?ref=<paypack_ref>
 *
 * Admin-only. Finds the CORRECT transaction-lookup endpoint for your Paypack
 * account by trying every plausible path and dumping the raw response for each.
 *
 * WHY THIS EXISTS
 * `src/lib/paypack.js` calls `/transactions/find/{ref}`. That path was written
 * from memory rather than verified against Paypack's documentation. If it is
 * wrong, findTransaction() throws, the catch in GET /api/payments/:id used to
 * swallow it, and the payment sits "pending" forever with nothing logged.
 * This tells you which path actually works for your account.
 *
 * USAGE
 *   1. Make a real payment and approve it on the phone
 *   2. Get the ref (Postman step 3, or the payments.provider_ref column)
 *   3. GET this endpoint with that ref
 *   4. Whichever candidate returns 200 AND contains your ref is the right one
 */
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { getAccessToken } = require('@/lib/paypack');

exports.dynamic = 'force-dynamic';

const BASE = (process.env.PAYPACK_BASE_URL || 'https://payments.paypack.rw/api')
  .replace(/\/+$/, '');
const MODE = (process.env.PAYPACK_ENV || 'development').toLowerCase();

/** Every shape a "look up one transaction" endpoint plausibly takes. */
function candidates(ref) {
  const r = encodeURIComponent(ref);
  return [
    `/transactions/find/${r}`,
    `/transactions/${r}`,
    `/transactions?ref=${r}`,
    `/transactions/find?ref=${r}`,
    `/events/transactions?ref=${r}`,
    `/transactions/list?ref=${r}`,
  ];
}

function truncate(s, n = 700) {
  if (typeof s !== 'string') s = JSON.stringify(s);
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}… (+${s.length - n} chars)` : s;
}

exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin']);

  const url = new URL(request.url);
  const ref = url.searchParams.get('ref');
  if (!ref) {
    throw new BadRequestError(
      'Pass ?ref=<paypack_ref> — take it from the payment row (provider_ref).',
    );
  }

  // Auth first. If this fails, nothing else matters.
  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    return ok({
      ref,
      base_url: BASE,
      auth: { ok: false, error: e.message },
      hint: 'Authentication failed, so every lookup will fail. Check '
        + 'PAYPACK_CLIENT_ID / PAYPACK_CLIENT_SECRET on Vercel, then redeploy.',
      attempts: [],
    });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Webhook-Mode': MODE,
  };

  const attempts = [];
  for (const path of candidates(ref)) {
    const started = Date.now();
    try {
      const res = await fetch(`${BASE}${path}`, { method: 'GET', headers });
      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }

      // A 200 that doesn't mention our ref is a list endpoint or a decoy,
      // not the single-transaction lookup we need.
      const mentionsRef = text.includes(ref);

      attempts.push({
        path,
        http: res.status,
        ms: Date.now() - started,
        looks_correct: res.ok && mentionsRef,
        mentions_ref: mentionsRef,
        body: parsed ?? truncate(text),
      });
    } catch (e) {
      attempts.push({
        path, http: null, ms: Date.now() - started,
        looks_correct: false, error: e.message,
      });
    }
  }

  const winner = attempts.find((a) => a.looks_correct);

  return ok({
    ref,
    base_url: BASE,
    webhook_mode: MODE,
    auth: { ok: true },
    correct_path: winner ? winner.path : null,
    verdict: winner
      ? `Use "${winner.path}" in findTransaction() — HTTP ${winner.http}, contains the ref.`
      : 'No candidate returned the transaction. Either the ref is wrong, the '
        + 'transaction belongs to a different environment (check PAYPACK_ENV against '
        + 'the mode the payment was made in), or the base URL is wrong. Read the raw '
        + 'bodies below — the real error is usually stated there.',
    attempts,
  });
});
