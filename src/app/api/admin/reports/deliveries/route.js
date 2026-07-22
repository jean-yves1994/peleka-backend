const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const filters = []; const params = [];
  if (from) { params.push(from); filters.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); filters.push(`created_at < $${params.length}::date + INTERVAL '1 day'`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const { rows: byStatus } = await query(
    `SELECT status::text AS status, COUNT(*)::int AS count FROM shipments ${where} GROUP BY status`, params
  );
  const { rows: [avg] } = await query(
    `SELECT
       AVG(EXTRACT(EPOCH FROM (delivered_at - assigned_at))/60)::numeric(10,2) AS avg_minutes_assigned_to_delivered,
       AVG(EXTRACT(EPOCH FROM (delivered_at - picked_up_at))/60)::numeric(10,2) AS avg_minutes_pickup_to_delivered,
       AVG(distance_km)::numeric(10,2) AS avg_distance_km
     FROM shipments ${where ? where + ' AND ' : 'WHERE '} status='delivered'
       AND delivered_at IS NOT NULL AND picked_up_at IS NOT NULL AND assigned_at IS NOT NULL`, params
  );
  return ok({ by_status: byStatus, delivery_time_stats: avg });
});
