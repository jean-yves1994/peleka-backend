const { withTransaction } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { cancelShipmentSchema } = require('@/lib/validation');
const { ok } = require('@/lib/response');
const { NotFoundError, ForbiddenError, ConflictError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { notify } = require('@/lib/notifications');

exports.dynamic = 'force-dynamic';
const CUSTOMER_ALLOWED = new Set(['awaiting_assignment','assigned']);
const ADMIN_ALLOWED = new Set(['awaiting_assignment','assigned','rider_en_route_to_pickup']);

exports.POST = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const { reason } = cancelShipmentSchema.parse(await readJson(request));
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM shipments WHERE id=$1 FOR UPDATE`, [params.id]);
    const s = rows[0];
    if (!s) throw new NotFoundError('Shipment not found');
    const isOwner = user.role === 'customer' && s.customer_id === user.id;
    const isAdmin = user.role === 'admin' || user.role === 'dispatcher';
    if (!isOwner && !isAdmin) throw new ForbiddenError();
    const allowed = isAdmin ? ADMIN_ALLOWED : CUSTOMER_ALLOWED;
    if (!allowed.has(s.status)) throw new ConflictError(`Cannot cancel a shipment with status "${s.status}"`);
    const { rows: [updated] } = await client.query(
      `UPDATE shipments SET status='cancelled', cancelled_at=NOW(),
              cancellation_reason=$2, cancelled_by=$3 WHERE id=$1 RETURNING *`,
      [s.id, reason, user.id]
    );
    await client.query(
      `INSERT INTO shipment_status_history (shipment_id, from_status, to_status, changed_by, note)
       VALUES ($1,$2,'cancelled',$3,$4)`, [s.id, s.status, user.id, reason]
    );
    await client.query(
      `UPDATE shipment_assignments SET status='cancelled', responded_at=NOW()
        WHERE shipment_id=$1 AND status IN ('offered','accepted')`, [s.id]
    );
    return updated;
  });
  await logAudit({ request, actor: user, action: 'shipment.cancelled',
    entityType: 'shipment', entityId: result.id, data: { reason } });
  try {
    await notify({ userId: result.customer_id, title: 'Shipment cancelled',
      body: `Shipment ${result.tracking_number} was cancelled`,
      data: { type: 'shipment.cancelled', shipment_id: result.id } });
    if (result.rider_id) await notify({ userId: result.rider_id, title: 'Shipment cancelled',
      body: `Shipment ${result.tracking_number} was cancelled`,
      data: { type: 'shipment.cancelled', shipment_id: result.id } });
  } catch(_) {}
  return ok({ shipment: result });
});
