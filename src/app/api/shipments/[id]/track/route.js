const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { riderLocationSchema } = require('@/lib/validation');
const { ok, created } = require('@/lib/response');
const { NotFoundError, ForbiddenError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const body = riderLocationSchema.parse(await readJson(request));
  const { rows } = await query(`SELECT rider_id, status FROM shipments WHERE id=$1`, [params.id]);
  const s = rows[0];
  if (!s) throw new NotFoundError('Shipment not found');
  if (user.role !== 'rider' || s.rider_id !== user.id) throw new ForbiddenError('Only the assigned rider can post pings');
  await query(
    `INSERT INTO shipment_tracking_pings (shipment_id, rider_id, lat, lng, heading, speed_kph)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [params.id, user.id, body.lat, body.lng, body.heading || null, body.speed_kph || null]
  );
  await query(
    `UPDATE rider_profiles SET current_lat=$2, current_lng=$3, last_location_at=NOW() WHERE user_id=$1`,
    [user.id, body.lat, body.lng]
  );
  return created({ recorded_at: new Date().toISOString() });
});
exports.GET = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const { rows: shipRows } = await query(
    `SELECT s.*, rp.current_lat AS rider_lat, rp.current_lng AS rider_lng, rp.last_location_at
       FROM shipments s LEFT JOIN rider_profiles rp ON rp.user_id=s.rider_id WHERE s.id=$1`,
    [params.id]
  );
  const s = shipRows[0];
  if (!s) throw new NotFoundError('Shipment not found');
  const authorized =
    (user.role === 'customer' && s.customer_id === user.id) ||
    (user.role === 'rider' && s.rider_id === user.id) ||
    user.role === 'admin' || user.role === 'dispatcher';
  if (!authorized) throw new ForbiddenError();
  const url = new URL(request.url);
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));
  const { rows: pings } = await query(
    `SELECT lat, lng, heading, speed_kph, recorded_at FROM shipment_tracking_pings
      WHERE shipment_id=$1 ORDER BY recorded_at DESC LIMIT $2`,
    [params.id, limit]
  );
  return ok({
    shipment: {
      id: s.id, tracking_number: s.tracking_number, status: s.status,
      pickup_lat: s.pickup_lat, pickup_lng: s.pickup_lng,
      delivery_lat: s.delivery_lat, delivery_lng: s.delivery_lng,
    },
    rider_last_location: s.rider_lat && s.rider_lng
      ? { lat: s.rider_lat, lng: s.rider_lng, at: s.last_location_at } : null,
    pings: pings.reverse(),
  });
});
