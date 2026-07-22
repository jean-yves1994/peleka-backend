const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
const BUCKETS = { day: 'day', week: 'week', month: 'month' };

exports.GET = withHandler(async (request) => {
  const user = await requireRole(request, ['rider']);
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const groupByRaw = (url.searchParams.get('groupBy') || 'day').toLowerCase();
  const groupBy = BUCKETS[groupByRaw];
  if (!groupBy) throw new BadRequestError('groupBy must be day|week|month');

  const filters = ['rider_id = $1', `status = 'delivered'`];
  const params = [user.id];
  if (from) { params.push(from); filters.push(`delivered_at >= $${params.length}`); }
  if (to)   { params.push(to);   filters.push(`delivered_at <  $${params.length}::date + INTERVAL '1 day'`); }
  const where = filters.join(' AND ');

  const [
    { rows: totalsRows },
    { rows: series },
    { rows: recent },
    { rows: [rp] },
    { rows: [today] },
    { rows: [week] },
    { rows: [month] },
  ] = await Promise.all([
    query(`SELECT COUNT(*)::int AS completed_jobs,
                  COALESCE(SUM(rider_earnings),0)::numeric(14,2) AS total_earnings,
                  COALESCE(AVG(distance_km),0)::numeric(10,2)    AS avg_distance_km,
                  currency
             FROM shipments WHERE ${where} GROUP BY currency`, params),
    query(`SELECT date_trunc('${groupBy}', delivered_at) AS bucket,
                  COUNT(*)::int AS deliveries,
                  COALESCE(SUM(rider_earnings),0)::numeric(14,2) AS earnings,
                  COALESCE(SUM(distance_km),0)::numeric(10,2)    AS distance_km
             FROM shipments WHERE ${where} GROUP BY bucket ORDER BY bucket ASC`, params),
    query(`SELECT id, tracking_number, delivered_at, distance_km, total_price, rider_earnings, currency
             FROM shipments WHERE ${where} ORDER BY delivered_at DESC LIMIT 20`, params),
    query(`SELECT rating_avg, rating_count, completed_jobs, status FROM rider_profiles WHERE user_id=$1`, [user.id]),
    query(`SELECT COUNT(*)::int AS deliveries,
                  COALESCE(SUM(rider_earnings),0)::numeric(14,2) AS earnings
             FROM shipments
            WHERE rider_id=$1 AND status='delivered'
              AND delivered_at >= date_trunc('day', NOW())`, [user.id]),
    query(`SELECT COUNT(*)::int AS deliveries,
                  COALESCE(SUM(rider_earnings),0)::numeric(14,2) AS earnings
             FROM shipments
            WHERE rider_id=$1 AND status='delivered'
              AND delivered_at >= date_trunc('week', NOW())`, [user.id]),
    query(`SELECT COUNT(*)::int AS deliveries,
                  COALESCE(SUM(rider_earnings),0)::numeric(14,2) AS earnings
             FROM shipments
            WHERE rider_id=$1 AND status='delivered'
              AND delivered_at >= date_trunc('month', NOW())`, [user.id]),
  ]);

  return ok({
    range: { from, to, groupBy },
    totals: totalsRows[0] || { completed_jobs: 0, total_earnings: 0, avg_distance_km: 0, currency: 'USD' },
    series, recent_deliveries: recent, profile: rp,
    today, this_week: week, this_month: month,
  });
});
