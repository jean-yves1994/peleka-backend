const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
const ACTIVE = ['assigned','rider_en_route_to_pickup','picked_up','in_transit','out_for_delivery'];
exports.GET = withHandler(async (request) => {
  const user = await requireRole(request, ['rider']);
  const { rows } = await query(
    `SELECT * FROM shipments WHERE rider_id=$1 AND status=ANY($2::shipment_status[]) ORDER BY assigned_at ASC`,
    [user.id, ACTIVE]
  );
  return ok(rows);
});
