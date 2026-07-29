/**
 * POST /api/payments/paypack/initiate
 * Body: { shipment_id, phone }
 *
 * Pushes a Mobile Money charge to the customer's phone (Request-to-Pay).
 * The customer approves with their MoMo PIN; Paypack then calls our webhook,
 * which flips the shipment `pending_payment` → `awaiting_assignment`.
 *
 * Auth: the shipment's customer (or an admin).
 */
const crypto = require('crypto');
const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { cashin, normalizePhone } = require('@/lib/paypack');
const { ok } = require('@/lib/response');
const {
  NotFoundError, ForbiddenError, ConflictError, BadRequestError,
} = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  const body = await readJson(request);
  const shipmentId = body?.shipment_id;
  if (!shipmentId) throw new BadRequestError('shipment_id is required');

  const { rows } = await query(
    `SELECT s.*, cu.email AS customer_email, cu.phone AS customer_phone,
            cu.full_name AS customer_name
       FROM shipments s
       JOIN users cu ON cu.id = s.customer_id
      WHERE s.id = $1`,
    [shipmentId],
  );
  const s = rows[0];
  if (!s) throw new NotFoundError('Shipment not found');

  const isOwner = user.role === 'customer' && s.customer_id === user.id;
  const isAdmin = user.role === 'admin' || user.role === 'dispatcher';
  if (!isOwner && !isAdmin) throw new ForbiddenError();

  if (s.status === 'cancelled') throw new ConflictError('Shipment is cancelled');
  if (['delivered', 'in_transit', 'out_for_delivery', 'picked_up'].includes(s.status)) {
    throw new ConflictError('Shipment is already in progress');
  }

  const paid = await query(
    `SELECT 1 FROM payments WHERE shipment_id = $1 AND status = 'paid' LIMIT 1`,
    [shipmentId],
  );
  if (paid.rowCount > 0) throw new ConflictError('Shipment is already paid');

  // Pay with the phone supplied in the request, else the account's phone.
  // normalizePhone throws a friendly 400 if it isn't a valid Rwandan MSISDN.
  const phone = normalizePhone(body?.phone || s.customer_phone);

  // Reuse a pending payment row if one exists; otherwise create it.
  let payment = (await query(
    `SELECT * FROM payments
      WHERE shipment_id = $1 AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1`,
    [shipmentId],
  )).rows[0];

  if (!payment) {
    payment = (await query(
      `INSERT INTO payments
         (shipment_id, customer_id, amount, currency, method, status, provider)
       VALUES ($1,$2,$3,$4,'mobile_money','pending','paypack')
       RETURNING *`,
      [shipmentId, s.customer_id, s.total_price, s.currency || 'RWF'],
    )).rows[0];
  }

  // Idempotency key must be ≤32 chars (Paypack limit).
  const idem = `plk${crypto.randomBytes(12).toString('hex')}`.slice(0, 32);

  let tx;
  try {
    tx = await cashin({
      amount: Number(s.total_price),
      phone,
      idempotencyKey: idem,
    });
  } catch (e) {
    await query(
      `UPDATE payments SET failure_reason = $2, updated_at = NOW() WHERE id = $1`,
      [payment.id, String(e.message || 'cashin failed').slice(0, 500)],
    );
    throw e;
  }

  // Store Paypack's transaction ref so the webhook can find this row.
  await query(
    `UPDATE payments
        SET provider_ref = $2,
            provider_meta = $3::jsonb,
            updated_at = NOW()
      WHERE id = $1`,
    [payment.id, tx.ref, JSON.stringify({ phone, idempotency_key: idem })],
  );

  await logAudit({
    request,
    actor: user,
    action: 'payment.paypack.initiated',
    entityType: 'payment',
    entityId: payment.id,
    data: {
      shipment_id: shipmentId,
      ref: tx.ref,
      amount: s.total_price,
      phone_last4: phone.slice(-4),
    },
  });

  return ok({
    payment_id: payment.id,
    ref: tx.ref,
    status: tx.status,            // 'pending' — customer must approve on phone
    amount: Number(s.total_price),
    currency: s.currency || 'RWF',
    phone_last4: phone.slice(-4),
    message: 'Check your phone and enter your Mobile Money PIN to approve.',
  });
});
