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
  const filters = [`s.status='delivered'`]; const params = [];
  if (from) { params.push(from); filters.push(`s.delivered_at >= $${params.length}`); }
  if (to) { params.push(to); filters.push(`s.delivered_at < $${params.length}::date + INTERVAL '1 day'`); }
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.email, u.phone,
            rp.rating_avg, rp.rating_count, rp.status,
            COUNT(s.id)::int AS deliveries,
            COALESCE(SUM(s.rider_earnings),0)::numeric(14,2) AS earnings,
            COALESCE(AVG(s.distance_km),0)::numeric(10,2) AS avg_distance_km
       FROM users u JOIN rider_profiles rp ON rp.user_id=u.id
  LEFT JOIN shipments s ON s.rider_id=u.id AND ${filters.join(' AND ')}
      WHERE u.role='rider' AND u.deleted_at IS NULL
   GROUP BY u.id, rp.rating_avg, rp.rating_count, rp.status
   ORDER BY deliveries DESC, earnings DESC LIMIT 100`, params
  );
  return ok(rows);
});
