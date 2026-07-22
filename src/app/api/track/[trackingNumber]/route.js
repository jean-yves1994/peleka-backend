const { query } = require('@/lib/db');
const { rateLimit, getClientIp } = require('@/lib/middleware');
const { ok } = require('@/lib/response');
const { NotFoundError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request, { params }) => {
  rateLimit(`track:${getClientIp(request) || 'unknown'}`, { max: 60, windowMs: 60_000 });
  const { rows } = await query(
    `SELECT id, tracking_number, status, pickup_city, delivery_city,
            split_part(recipient_name, ' ', 1) AS recipient_first_name,
            picked_up_at, delivered_at, created_at
       FROM shipments WHERE tracking_number=$1`, [params.trackingNumber]
  );
  const s = rows[0];
  if (!s) throw new NotFoundError('Tracking number not found');
  const { rows: history } = await query(
    `SELECT to_status::text AS status, note, created_at
       FROM shipment_status_history WHERE shipment_id=$1 ORDER BY created_at ASC`,
    [s.id]
  );
  return ok({ shipment: s, timeline: history });
});
