const { withTransaction } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { updatePaymentStatusSchema } = require('@/lib/validation');
const { ok } = require('@/lib/response');
const { NotFoundError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.PATCH = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin']);
  const body = updatePaymentStatusSchema.parse(await readJson(request));
  const updated = await withTransaction(async (client) => {
    const paidAt = body.status === 'paid' ? new Date() : null;
    const refundedAt = body.status === 'refunded' ? new Date() : null;
    const { rows } = await client.query(
      `UPDATE payments SET status=$2,
          provider_ref=COALESCE($3, provider_ref),
          failure_reason=COALESCE($4, failure_reason),
          paid_at=COALESCE($5, paid_at),
          refunded_at=COALESCE($6, refunded_at)
        WHERE id=$1 RETURNING *`,
      [params.id, body.status, body.provider_ref || null, body.failure_reason || null, paidAt, refundedAt]
    );
    const p = rows[0];
    if (!p) throw new NotFoundError('Payment not found');
    if (body.status === 'paid') {
      await client.query(`UPDATE shipments SET status='awaiting_assignment' WHERE id=$1 AND status='pending_payment'`, [p.shipment_id]);
    }
    return p;
  });
  await logAudit({ request, actor: admin, action: `payment.${body.status}`, entityType: 'payment', entityId: params.id });
  return ok(updated);
});
