const { withTransaction } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { NotFoundError, ConflictError, ForbiddenError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { notify } = require('@/lib/notifications');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request, { params }) => {
  const user = await requireRole(request, ['rider']);
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM shipment_assignments WHERE id=$1 FOR UPDATE`, [params.id]);
    const a = rows[0];
    if (!a) throw new NotFoundError('Assignment not found');
    if (a.rider_id !== user.id) throw new ForbiddenError();
    if (a.status !== 'offered') throw new ConflictError(`Assignment is "${a.status}"`);
    if (a.expires_at && new Date(a.expires_at) < new Date()) {
      await client.query(`UPDATE shipment_assignments SET status='expired' WHERE id=$1`, [a.id]);
      throw new ConflictError('Assignment offer expired');
    }
    const { rows: [assignment] } = await client.query(
      `UPDATE shipment_assignments SET status='accepted', responded_at=NOW() WHERE id=$1 RETURNING *`, [a.id]
    );
    const { rows: [shipment] } = await client.query(
      `UPDATE shipments SET rider_id=$2, status='assigned', assigned_at=NOW() WHERE id=$1 RETURNING *`,
      [a.shipment_id, user.id]
    );
    await client.query(
      `INSERT INTO shipment_status_history (shipment_id, from_status, to_status, changed_by, note)
       VALUES ($1, 'awaiting_assignment', 'assigned', $2, 'Rider accepted assignment')`,
      [shipment.id, user.id]
    );
    await client.query(
      `UPDATE shipment_assignments SET status='cancelled', responded_at=NOW()
        WHERE shipment_id=$1 AND id<>$2 AND status='offered'`, [shipment.id, a.id]
    );
    return { assignment, shipment };
  });
  await logAudit({ request, actor: user, action: 'assignment.accepted', entityType: 'shipment', entityId: result.shipment.id });
  try {
    await notify({ userId: result.shipment.customer_id, title: 'A rider has been assigned',
      body: `Your shipment ${result.shipment.tracking_number} has an assigned rider`,
      data: { type: 'shipment.assigned', shipment_id: result.shipment.id } });
  } catch(_) {}
  return ok(result);
});
