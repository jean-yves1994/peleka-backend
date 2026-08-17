const { withTransaction } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { shipmentStatusUpdateSchema } = require('@/lib/validation');
const { ok } = require('@/lib/response');
const { NotFoundError, ForbiddenError, ConflictError, BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { notify } = require('@/lib/notifications');

exports.dynamic = 'force-dynamic';
const TRANSITIONS = {
  assigned: new Set(['rider_en_route_to_pickup','failed_pickup','cancelled']),
  rider_en_route_to_pickup: new Set(['picked_up','failed_pickup','cancelled']),
  picked_up: new Set(['in_transit','out_for_delivery','failed_delivery']),
  in_transit: new Set(['out_for_delivery','failed_delivery']),
  out_for_delivery: new Set(['delivered','failed_delivery','returned']),
};

exports.PATCH = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const body = shipmentStatusUpdateSchema.parse(await readJson(request));
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM shipments WHERE id=$1 FOR UPDATE`, [params.id]);
    const s = rows[0];
    if (!s) throw new NotFoundError('Shipment not found');
    const isAssignedRider = user.role === 'rider' && s.rider_id === user.id;
    const isAdmin = user.role === 'admin' || user.role === 'dispatcher';
    if (!isAssignedRider && !isAdmin) throw new ForbiddenError('Only the assigned rider or an admin can update status');
    const allowed = TRANSITIONS[s.status];
    if (!allowed || !allowed.has(body.status)) throw new ConflictError(`Illegal transition: ${s.status} → ${body.status}`);

    if (body.status === 'picked_up') {
      const p = await client.query(`SELECT 1 FROM shipment_proofs WHERE shipment_id=$1 AND kind='pickup_photo' LIMIT 1`, [s.id]);
      if (p.rowCount === 0) throw new BadRequestError('Pickup photo proof is required before confirming pickup');
    }
    if (body.status === 'delivered') {
      const p = await client.query(`SELECT 1 FROM shipment_proofs WHERE shipment_id=$1 AND kind='delivery_photo' LIMIT 1`, [s.id]);
      if (p.rowCount === 0) throw new BadRequestError('Delivery photo proof is required before marking delivered');
    }
    const ts = {};
    if (body.status === 'picked_up') ts.picked_up_at = new Date();
    if (body.status === 'delivered') ts.delivered_at = new Date();

    const { rows: [updated] } = await client.query(
      `UPDATE shipments SET status=$2,
          picked_up_at=COALESCE($3, picked_up_at),
          delivered_at=COALESCE($4, delivered_at)
       WHERE id=$1 RETURNING *`,
      [s.id, body.status, ts.picked_up_at || null, ts.delivered_at || null]
    );
    await client.query(
      `INSERT INTO shipment_status_history (shipment_id, from_status, to_status, changed_by, note, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [s.id, s.status, body.status, user.id, body.note || null, body.lat || null, body.lng || null]
    );
    if (body.status === 'delivered') {
      await client.query(`UPDATE rider_profiles SET completed_jobs=completed_jobs+1 WHERE user_id=$1`, [s.rider_id]);
      await client.query(
        `UPDATE shipment_assignments SET status='completed', responded_at=NOW()
          WHERE shipment_id=$1 AND rider_id=$2 AND status='accepted'`,
        [s.id, s.rider_id]
      );
    }
    return updated;
  });
  await logAudit({ request, actor: user, action: `shipment.status.${body.status}`,
    entityType: 'shipment', entityId: result.id, data: { note: body.note } });
  try {
    const msgs = {
      picked_up: 'Your parcel has been picked up',
      in_transit: 'Your parcel is in transit',
      out_for_delivery: 'Your parcel is out for delivery',
      delivered: 'Your parcel has been delivered',
      failed_pickup: 'Pickup attempt failed',
      failed_delivery: 'Delivery attempt failed',
    };
    if (msgs[body.status]) {
      await notify({ userId: result.customer_id, title: msgs[body.status],
        body: `Shipment ${result.tracking_number}`,
        data: { type: `shipment.${body.status}`, shipment_id: result.id } });
    }
  } catch(_) {}
  return ok({ shipment: result });
});
