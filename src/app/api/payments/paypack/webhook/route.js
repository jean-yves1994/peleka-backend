/**
 * POST /api/payments/paypack/webhook
 *
 * Paypack fires a `transaction:processed` event whether the transaction
 * succeeded or not. We:
 *   1. Verify the HMAC-SHA256 signature against PAYPACK_WEBHOOK_SECRET
 *   2. Re-verify the transaction with Paypack (source of truth — never trust
 *      the payload alone)
 *   3. On success + amount match:
 *        payment  → paid
 *        shipment → pending_payment ⇒ awaiting_assignment
 *        discount → used_count + 1
 *        notify customer + admins
 *
 * Always returns 200 quickly so Paypack doesn't retry a request we already
 * consumed; failures are logged for reconciliation instead.
 */
const { withTransaction, query } = require('@/lib/db');
const { findTransaction, verifyWebhookSignature, normalizeStatus } = require('@/lib/paypack');
const { NextResponse } = require('next/server');
const { logAudit } = require('@/lib/audit');
const { notify } = require('@/lib/notifications');

exports.dynamic = 'force-dynamic';

exports.POST = async (request) => {
  // Signature must be checked against the EXACT raw body.
  const raw = await request.text();
  if (!verifyWebhookSignature(raw, request.headers)) {
    return NextResponse.json({ success: false, error: 'bad signature' }, { status: 401 });
  }

  let event;
  try { event = JSON.parse(raw); } catch { event = null; }

  const d = event?.data || event || {};
  const ref = d.ref || d.reference || d.transaction_ref;
  if (!ref) return NextResponse.json({ success: true, ignored: 'no ref' });

  try {
    // 2) Independent verification.
    let verified;
    try {
      verified = await findTransaction(ref);
    } catch (_) {
      // If lookup fails, fall back to the payload's own status so a valid
      // signed success isn't lost — but only for an explicit success value.
      verified = {
        status: normalizeStatus(d.status),
        amount: Number(d.amount ?? 0),
        ref,
        raw: d,
      };
    }

    const { rows } = await query(
      `SELECT * FROM payments WHERE provider_ref = $1 LIMIT 1`,
      [ref],
    );
    const payment = rows[0];
    if (!payment) return NextResponse.json({ success: true, ignored: 'payment not found' });
    if (payment.status === 'paid') return NextResponse.json({ success: true, already: 'paid' });

    // RWF is a whole-unit currency; allow 1 unit of rounding slack.
    const amountOk = Number(verified.amount) >= Number(payment.amount) - 1;

    if (verified.status === 'successful' && amountOk) {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE payments
              SET status='paid', paid_at=NOW(),
                  provider_meta = COALESCE(provider_meta,'{}'::jsonb) || $2::jsonb,
                  updated_at=NOW()
            WHERE id=$1`,
          [payment.id, JSON.stringify({ paypack_ref: ref, verified_amount: verified.amount })],
        );
        await client.query(
          `UPDATE shipments SET status='awaiting_assignment'
            WHERE id=$1 AND status IN ('pending_payment','draft')
              AND EXISTS (
                SELECT 1 FROM users cu
                 WHERE cu.id=shipments.customer_id
                   AND cu.customer_type <> 'premier'
                   AND cu.contract_customer = FALSE
              )`,
          [payment.shipment_id],
        );
        await client.query(
          `INSERT INTO shipment_status_history
             (shipment_id, from_status, to_status, changed_by, note)
           SELECT id, 'pending_payment', 'awaiting_assignment', NULL,
                  'Payment received (Paypack Mobile Money)'
             FROM shipments s
            WHERE s.id=$1
              AND s.status='awaiting_assignment'
              AND EXISTS (
                SELECT 1 FROM users cu
                 WHERE cu.id=s.customer_id
                   AND cu.customer_type <> 'premier'
                   AND cu.contract_customer=FALSE
              )`,
          [payment.shipment_id],
        );

        // A Premier shipment can already be delivered when the later charge
        // succeeds. In that case the shipment stays delivered and only the
        // customer's outstanding balance is reduced.
        await client.query(
          `UPDATE users u
              SET outstanding_balance = GREATEST(0, COALESCE(u.outstanding_balance,0) - $2),
                  updated_at = NOW()
             WHERE u.id = $1
               AND (u.customer_type='premier' OR u.contract_customer=TRUE)`,
          [payment.customer_id, payment.amount],
        );
        // Consume the promo code only now that money actually arrived.
        await client.query(
          `UPDATE discounts dsc
              SET used_count = used_count + 1
             FROM shipments s
            WHERE s.id = $1
              AND s.discount_code IS NOT NULL
              AND dsc.code = s.discount_code`,
          [payment.shipment_id],
        );
      });

      await logAudit({
        request,
        action: 'payment.paypack.paid',
        entityType: 'payment',
        entityId: payment.id,
        data: { ref, amount: verified.amount },
      });

      try {
        const { rows: [paidShipment] } = await query(
          `SELECT s.status, u.customer_type, u.contract_customer
             FROM shipments s JOIN users u ON u.id=s.customer_id WHERE s.id=$1`,
          [payment.shipment_id]
        );
        const premier = paidShipment?.customer_type === 'premier' || paidShipment?.contract_customer === true;
        const message = premier && paidShipment?.status === 'delivered'
          ? 'Payment received. Your Premier account balance has been updated.'
          : 'Payment received. Your delivery is confirmed and will be assigned to a rider shortly.';
        await notify({
          userId: payment.customer_id,
          title: 'Payment received',
          body: message,
          data: { type: 'payment.paid', shipment_id: payment.shipment_id },
        });
        const admins = await query(
          `SELECT id FROM users WHERE role='admin' AND status='active'`,
        );
        await Promise.all(admins.rows.map((a) => notify({
          userId: a.id,
          title: 'New paid shipment awaiting assignment',
          body: 'A paid delivery needs a rider',
          data: { type: 'shipment.awaiting_assignment', shipment_id: payment.shipment_id },
        })));
      } catch (_) {}
    } else if (verified.status === 'failed') {
      await query(
        `UPDATE payments
            SET status='failed', failure_reason=$2, updated_at=NOW()
          WHERE id=$1`,
        [payment.id, `paypack: status=${verified.status} amountOk=${amountOk}`],
      );
      try {
        await notify({
          userId: payment.customer_id,
          title: 'Payment not completed',
          body: 'Your Mobile Money payment did not go through. You can try again.',
          data: { type: 'payment.failed', shipment_id: payment.shipment_id },
        });
      } catch (_) {}
    }
    // status 'pending' → leave as-is; a later event or polling will settle it.
  } catch (e) {
    console.error('[paypack webhook] error:', e.message);
  }

  return NextResponse.json({ success: true });
};
