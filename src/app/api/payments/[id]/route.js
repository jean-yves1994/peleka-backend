/**
 * GET   /api/payments/:id  → payment status (owner or admin)
 * PATCH /api/payments/:id  → admin manual override (webhook fallback)
 *
 * The app polls GET while the customer approves the MoMo prompt on their
 * phone. If the webhook is delayed, GET also does a live lookup against
 * Paypack so the customer isn't stuck waiting on our inbox.
 */
const { withTransaction, query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth, requireRole } = require('@/lib/auth');
const { findTransaction } = require('@/lib/paypack');
const { ok } = require('@/lib/response');
const { NotFoundError, ForbiddenError, BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

exports.GET = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const { rows } = await query(`SELECT * FROM payments WHERE id=$1`, [params.id]);
  let p = rows[0];
  if (!p) throw new NotFoundError('Payment not found');

  const isOwner = user.role === 'customer' && p.customer_id === user.id;
  const isAdmin = user.role === 'admin' || user.role === 'dispatcher';
  if (!isOwner && !isAdmin) throw new ForbiddenError();

  // Still pending? Ask Paypack directly — the webhook may lag or be blocked
  // (e.g. tunnel down in dev). This makes the app's polling authoritative.
  if (p.status === 'pending' && p.provider === 'paypack' && p.provider_ref) {
    try {
      const v = await findTransaction(p.provider_ref);
      const amountOk = Number(v.amount) >= Number(p.amount) - 1;

      if (v.status === 'successful' && amountOk) {
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE payments SET status='paid', paid_at=NOW(), updated_at=NOW()
              WHERE id=$1 AND status='pending'`,
            [p.id],
          );
          await client.query(
            `UPDATE shipments SET status='awaiting_assignment'
              WHERE id=$1 AND status IN ('pending_payment','draft')`,
            [p.shipment_id],
          );
          await client.query(
            `INSERT INTO shipment_status_history
               (shipment_id, from_status, to_status, changed_by, note)
             SELECT id, 'pending_payment', 'awaiting_assignment', NULL,
                    'Payment confirmed (Paypack lookup)'
               FROM shipments WHERE id=$1 AND status='awaiting_assignment'`,
            [p.shipment_id],
          );
          await client.query(
            `UPDATE discounts dsc SET used_count = used_count + 1
               FROM shipments s
              WHERE s.id = $1 AND s.discount_code IS NOT NULL
                AND dsc.code = s.discount_code`,
            [p.shipment_id],
          );
        });
        p = (await query(`SELECT * FROM payments WHERE id=$1`, [p.id])).rows[0];
      } else if (v.status === 'failed') {
        await query(
          `UPDATE payments SET status='failed', failure_reason=$2, updated_at=NOW()
            WHERE id=$1 AND status='pending'`,
          [p.id, 'paypack lookup: failed'],
        );
        p = (await query(`SELECT * FROM payments WHERE id=$1`, [p.id])).rows[0];
      }
    } catch (_) {
      // Lookup failed — return the stored status; the app keeps polling.
    }
  }

  return ok(p);
});

exports.PATCH = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin']);
  const body = await readJson(request);
  const status = body?.status;
  if (!status) throw new BadRequestError('status is required');

  const updated = await withTransaction(async (client) => {
    const paidAt = status === 'paid' ? new Date() : null;
    const { rows } = await client.query(
      `UPDATE payments
          SET status=$2,
              provider_ref=COALESCE($3, provider_ref),
              paid_at=COALESCE($4, paid_at),
              updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [params.id, status, body?.provider_ref || null, paidAt],
    );
    const p = rows[0];
    if (!p) throw new NotFoundError('Payment not found');
    if (status === 'paid') {
      await client.query(
        `UPDATE shipments SET status='awaiting_assignment'
          WHERE id=$1 AND status IN ('pending_payment','draft')`,
        [p.shipment_id],
      );
    }
    return p;
  });

  await logAudit({
    request, actor: admin, action: `payment.${status}`,
    entityType: 'payment', entityId: params.id,
  });
  return ok(updated);
});
