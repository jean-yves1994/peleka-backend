/**
 * GET   /api/payments/:id  → payment status (owner or admin)
 * PATCH /api/payments/:id  → admin manual override
 *
 * The app polls GET every 3s while the customer sits on the waiting screen.
 * While a payment is pending, this endpoint ALSO does a live Paypack lookup,
 * so payment confirms even if the webhook never arrives.
 *
 * WHAT CHANGED — and why it matters
 * The lookup used to sit behind `catch (_) {}`. If findTransaction() threw —
 * wrong endpoint path, auth failure, network block — the error vanished and
 * this endpoint kept answering "pending" forever with nothing logged anywhere.
 * That is indistinguishable from "the customer hasn't paid yet", which is
 * exactly why a confirmed payment could sit unpaid with no clue as to why.
 *
 * Now the error is logged AND returned in a `lookup` field, so you can see it
 * from Postman without digging through Vercel logs.
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

  // Diagnostics about the live lookup. Admins see it all; customers only ever
  // see whether we checked — never internal error text.
  let lookup = { attempted: false };

  if (p.status === 'pending' && p.provider === 'paypack') {
    if (!p.provider_ref) {
      // The cashin call never returned a ref, so nothing can match this row —
      // not the webhook, not this lookup. Worth saying out loud.
      lookup = { attempted: false, reason: 'no_provider_ref' };
      console.error(`[payments] ${p.id} has no provider_ref — cashin never returned one. `
        + `This payment can never be confirmed automatically.`);
    } else {
      lookup.attempted = true;
      try {
        const v = await findTransaction(p.provider_ref);
        lookup.provider_status = v.status;
        lookup.provider_amount = v.amount;

        // RWF is whole-unit; allow 1 unit of rounding slack.
        const amountOk = Number(v.amount) >= Number(p.amount) - 1;
        lookup.amount_ok = amountOk;

        if (v.status === 'successful' && amountOk) {
          await withTransaction(async (client) => {
            await client.query(
              `UPDATE payments SET status='paid', paid_at=NOW(), updated_at=NOW()
                WHERE id=$1 AND status='pending'`, [p.id]);
            await client.query(
              `UPDATE shipments SET status='awaiting_assignment'
                WHERE id=$1 AND status IN ('pending_payment','draft')`, [p.shipment_id]);
            await client.query(
              `INSERT INTO shipment_status_history
                 (shipment_id, from_status, to_status, changed_by, note)
               SELECT id, 'pending_payment', 'awaiting_assignment', NULL,
                      'Payment confirmed (Paypack lookup)'
                 FROM shipments WHERE id=$1 AND status='awaiting_assignment'`, [p.shipment_id]);
            // Consume the promo code only now that money actually arrived.
            await client.query(
              `UPDATE discounts dsc SET used_count = used_count + 1
                 FROM shipments s
                WHERE s.id = $1 AND s.discount_code IS NOT NULL
                  AND dsc.code = s.discount_code`, [p.shipment_id]);
          });
          p = (await query(`SELECT * FROM payments WHERE id=$1`, [p.id])).rows[0];
          console.log(`[payments] ${p.id} confirmed paid via lookup (${v.amount})`);

        } else if (v.status === 'successful' && !amountOk) {
          // Money arrived but the amounts disagree. Previously this did nothing
          // at all — silently leaving the payment pending.
          console.error(`[payments] ${p.id} AMOUNT MISMATCH — Paypack says ${v.amount}, `
            + `we expected ${p.amount}. Not marking paid.`);

        } else if (v.status === 'failed') {
          await query(
            `UPDATE payments SET status='failed', failure_reason=$2, updated_at=NOW()
              WHERE id=$1 AND status='pending'`, [p.id, 'paypack lookup: failed']);
          p = (await query(`SELECT * FROM payments WHERE id=$1`, [p.id])).rows[0];
        }
        // 'pending' → genuinely still pending; the app keeps polling.

      } catch (e) {
        // THE IMPORTANT CHANGE: surface it instead of swallowing it.
        lookup.error = e.message;
        console.error(
          `[payments] lookup FAILED for ${p.id} (ref=${p.provider_ref}): ${e.message}\n`
          + `  → If this is a 404, the transaction-lookup path in src/lib/paypack.js\n`
          + `    is wrong for your account. Run:\n`
          + `    GET /api/admin/paypack-probe?ref=${p.provider_ref}`);
      }
    }
  }

  return ok(isAdmin ? { ...p, lookup } : { ...p, lookup: { attempted: lookup.attempted } });
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
          SET status=$2, provider_ref=COALESCE($3, provider_ref),
              paid_at=COALESCE($4, paid_at), updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [params.id, status, body?.provider_ref || null, paidAt]);
    const p = rows[0];
    if (!p) throw new NotFoundError('Payment not found');

    if (status === 'paid') {
      await client.query(
        `UPDATE shipments SET status='awaiting_assignment'
          WHERE id=$1 AND status IN ('pending_payment','draft')`, [p.shipment_id]);
      await client.query(
        `INSERT INTO shipment_status_history
           (shipment_id, from_status, to_status, changed_by, note)
         SELECT id, 'pending_payment', 'awaiting_assignment', $2,
                'Payment marked paid by admin'
           FROM shipments WHERE id=$1 AND status='awaiting_assignment'`,
        [p.shipment_id, admin.id]);
    }
    return p;
  });

  await logAudit({ request, actor: admin, action: `payment.${status}`,
    entityType: 'payment', entityId: params.id });
  return ok(updated);
});
