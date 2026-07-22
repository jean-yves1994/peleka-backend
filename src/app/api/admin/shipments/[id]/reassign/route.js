const { withTransaction } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { assignShipmentSchema } = require('@/lib/validation');
const { ok } = require('@/lib/response');
const { NotFoundError, ConflictError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { notify } = require('@/lib/notifications');

exports.dynamic = 'force-dynamic';
const PRE_PICKUP = new Set(['awaiting_assignment','assigned','rider_en_route_to_pickup']);

exports.POST = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin','dispatcher']);
  const body = assignShipmentSchema.parse(await readJson(request));
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM shipments WHERE id=$1 FOR UPDATE`, [params.id]);
    const s = rows[0];
    if (!s) throw new NotFoundError('Shipment not found');
    if (!PRE_PICKUP.has(s.status)) throw new ConflictError(`Cannot reassign a shipment with status "${s.status}"`);
    await client.query(
      `UPDATE shipment_assignments SET status='cancelled', responded_at=NOW()
        WHERE shipment_id=$1 AND status IN ('offered','accepted')`, [s.id]
    );
    const { rows: [reset] } = await client.query(
      `UPDATE shipments SET rider_id=NULL, status='awaiting_assignment', assigned_at=NULL
        WHERE id=$1 RETURNING *`, [s.id]
    );
    await client.query(
      `INSERT INTO shipment_status_history (shipment_id, from_status, to_status, changed_by, note)
       VALUES ($1,$2,'awaiting_assignment',$3,'Reassignment initiated')`,
      [s.id, s.status, admin.id]
    );
    const expiresIn = (body.expires_in_minutes || 15) * 60 * 1000;
    const { rows: [assignment] } = await client.query(
      `INSERT INTO shipment_assignments (shipment_id, rider_id, assigned_by, status, expires_at)
       VALUES ($1,$2,$3,'offered', NOW() + ($4::int * INTERVAL '1 millisecond'))
       RETURNING *`, [s.id, body.rider_id, admin.id, expiresIn]
    );
    return { shipment: reset, assignment };
  });
  await logAudit({ request, actor: admin, action: 'shipment.reassigned',
    entityType: 'shipment', entityId: params.id, data: { rider_id: body.rider_id } });
  try {
    await notify({ userId: body.rider_id, title: 'New delivery offer',
      body: `You have a new delivery offer`,
      data: { type: 'assignment.offered', shipment_id: params.id, assignment_id: result.assignment.id } });
  } catch(_) {}
  return ok(result);
});
