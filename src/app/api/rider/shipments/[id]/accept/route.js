const { withTransaction } = require('@/lib/db');
const { requireAuth } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { ForbiddenError, ConflictError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { notify } = require('@/lib/notifications');

/**
 * POST /api/rider/shipments/:id/accept — rider claims a job.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RACE
 *
 * Two riders see the same job and tap Accept milliseconds apart. The obvious
 * version assigns it to both:
 *
 *     SELECT ... WHERE rider_id IS NULL;   // both see it free
 *     UPDATE ... SET rider_id = me;        // second overwrites the first
 *
 * The fix is a single conditional UPDATE carrying its own guard:
 *
 *     UPDATE shipments SET rider_id = $me
 *      WHERE id = $1 AND rider_id IS NULL AND status = 'awaiting_assignment'
 *
 * Postgres serialises the two writes. The first gets rowCount 1, the second
 * gets 0 and a clear "already taken". There's no window between the check and
 * the write because they're the same statement.
 *
 * ⚠️ If ConflictError doesn't exist in your @/lib/errors, swap it for
 *    BadRequestError — the message still reads correctly, you just lose the 409.
 */

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request, { params }) => {
  const rider = await requireAuth(request);
  if (rider.role !== 'rider') throw new ForbiddenError('Riders only');

  const shipment = await withTransaction(async (client) => {
    const { rows, rowCount } = await client.query(
      `UPDATE shipments
          SET rider_id    = $1,
              assigned_at = NOW(),
              status      = 'rider_en_route_to_pickup',
              updated_at  = NOW()
        WHERE id = $2
          AND rider_id IS NULL
          AND status = 'awaiting_assignment'
          AND EXISTS (
            SELECT 1
              FROM users cu
             WHERE cu.id=shipments.customer_id
               AND (
                 cu.customer_type='premier'
                 OR cu.contract_customer=TRUE
                 OR EXISTS (
                   SELECT 1 FROM payments p
                    WHERE p.shipment_id=shipments.id AND p.status='paid'
                 )
               )
          )
        RETURNING *`,
      [rider.id, params.id]
    );

    if (rowCount === 0) {
      // Either another rider won the race, or it was never claimable —
      // 'pending_payment' shipments never reach the pool, so an unpaid one
      // can't be taken even by direct call.
      throw new ConflictError(
        'This delivery is no longer available. Another rider may have just '
        + 'accepted it — pull down to refresh.'
      );
    }

    await client.query(
      `INSERT INTO shipment_status_history (shipment_id, from_status, to_status, changed_by, note)
       VALUES ($1, 'awaiting_assignment', 'rider_en_route_to_pickup', $2, $3)`,
      [params.id, rider.id, 'Accepted by rider from the available pool']
    );

    return rows[0];
  });

  await logAudit({
    request, actor: rider, action: 'shipment.accepted_by_rider',
    entityType: 'shipment', entityId: params.id,
    data: { tracking_number: shipment.tracking_number },
  });

  try {
    await notify({
      userId: shipment.customer_id,
      title: 'A rider is on the way',
      body: `${rider.full_name} has accepted delivery ${shipment.tracking_number}`,
      data: { type: 'shipment.assigned', shipment_id: shipment.id },
    });
  } catch (_) {}

  return ok(shipment);
});
