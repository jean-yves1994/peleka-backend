/**
 * POST /api/payments/paypack/echo
 *
 * A throwaway webhook receiver that logs EVERYTHING Paypack sends and always
 * returns 200. Point Paypack at this temporarily to discover the real shape of
 * their callback — header names, body fields, status values.
 *
 * WHY THIS EXISTS
 * The real webhook verifies an HMAC signature read from headers named
 * `x-paypack-signature` / `paypack-signature` / `x-signature`, and pulls the
 * transaction ref from `data.ref`. Those names were written from memory, not
 * verified. If any is wrong, the webhook rejects every call with 401 (or can't
 * match the payment) and the shipment stays unpaid — exactly your symptom.
 *
 * HOW TO USE
 *   1. Paypack dashboard → your app → Webhooks → set URL to:
 *        https://YOUR-BACKEND/api/payments/paypack/echo
 *   2. Make one small real payment and approve it
 *   3. Vercel → Logs → filter "paypack echo"
 *   4. Compare what you see against src/lib/paypack.js and fix the names
 *   5. Point the webhook back at .../paypack/webhook
 *
 * ⚠️ DELETE THIS ROUTE when done. It accepts unauthenticated requests.
 */
const { NextResponse } = require('next/server');

exports.dynamic = 'force-dynamic';

exports.POST = async (request) => {
  const raw = await request.text();

  // Header names are what we're hunting, so print them all.
  const headers = {};
  request.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    // Show that a secret-ish header arrived and its length, without printing
    // the value into your logs.
    const sensitive = k.includes('signature') || k.includes('secret') || k === 'authorization';
    headers[key] = sensitive ? `<present, ${String(value).length} chars>` : value;
  });

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* not JSON */ }

  console.log('════════ paypack echo ════════');
  console.log('HEADERS:', JSON.stringify(headers, null, 2));
  console.log('BODY:', raw.slice(0, 2000));

  if (parsed) {
    const d = parsed.data || parsed;
    console.log('PARSED FIELDS:', JSON.stringify({
      event: parsed.event ?? null,
      'data.ref': d?.ref ?? null,
      'data.reference': d?.reference ?? null,
      'data.transaction_ref': d?.transaction_ref ?? null,
      'data.status': d?.status ?? null,
      'data.amount': d?.amount ?? null,
      'data.kind': d?.kind ?? null,
      top_level_keys: Object.keys(parsed),
      data_keys: d && typeof d === 'object' ? Object.keys(d) : null,
    }, null, 2));

    if (!(d?.ref || d?.reference || d?.transaction_ref)) {
      console.log('⚠ No ref under any expected key. The real webhook cannot match '
        + 'this to a payment row. Check data_keys above.');
    }
  }
  console.log('══════════════════════════════');

  // Always 200 — never make Paypack retry against a debug endpoint.
  return NextResponse.json({ success: true, echoed: true });
};

// Some providers probe with GET before sending events.
exports.GET = async () => NextResponse.json({
  success: true,
  message: 'Paypack echo endpoint is reachable. Send a POST to see it log.',
});
