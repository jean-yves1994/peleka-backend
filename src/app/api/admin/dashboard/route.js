const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const [
    { rows: [ship] },
    { rows: [rev] },
    { rows: [riders] },
    { rows: recentShipments },
    { rows: byStatus },
  ] = await Promise.all([
    query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='delivered')::int AS delivered,
      COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
      COUNT(*) FILTER (WHERE status NOT IN ('delivered','cancelled','failed_pickup','failed_delivery','returned'))::int AS active,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last_24h
     FROM shipments`),
    query(`SELECT
      COALESCE(SUM(total_price),0)::numeric(14,2) AS revenue_total,
      COALESCE(SUM(total_price) FILTER (WHERE delivered_at >= NOW() - INTERVAL '30 days'),0)::numeric(14,2) AS revenue_30d,
      COALESCE(SUM(total_price) FILTER (WHERE delivered_at >= NOW() - INTERVAL '7 days'),0)::numeric(14,2)  AS revenue_7d,
      COALESCE(SUM(rider_earnings),0)::numeric(14,2) AS rider_payouts_total
     FROM shipments WHERE status='delivered'`),
    query(`SELECT
      COUNT(*) FILTER (WHERE status='online')::int   AS online,
      COUNT(*) FILTER (WHERE status='busy')::int     AS busy,
      COUNT(*) FILTER (WHERE status='approved')::int AS approved,
      COUNT(*) FILTER (WHERE status='pending_approval')::int AS pending_approval,
      COUNT(*) FILTER (WHERE status='suspended')::int AS suspended
     FROM rider_profiles`),
    query(`SELECT id, tracking_number, status, total_price, currency, created_at
             FROM shipments ORDER BY created_at DESC LIMIT 10`),
    query(`SELECT status::text AS status, COUNT(*)::int AS count FROM shipments GROUP BY status`),
  ]);
  return ok({ shipments: ship, revenue: rev, riders, by_status: byStatus, recent_shipments: recentShipments });
});
