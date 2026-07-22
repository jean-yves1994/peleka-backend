const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
const BUCKETS = { day: 'day', week: 'week', month: 'month' };
exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const groupBy = BUCKETS[url.searchParams.get('groupBy') || 'day'];
  if (!groupBy) throw new BadRequestError('groupBy must be day|week|month');
  const filters = [`status='delivered'`]; const params = [];
  if (from) { params.push(from); filters.push(`delivered_at >= $${params.length}`); }
  if (to) { params.push(to); filters.push(`delivered_at < $${params.length}::date + INTERVAL '1 day'`); }
  const where = `WHERE ${filters.join(' AND ')}`;
  const { rows } = await query(
    `SELECT date_trunc('${groupBy}', delivered_at) AS bucket,
            COUNT(*)::int AS deliveries,
            COALESCE(SUM(total_price),0)::numeric(14,2) AS revenue,
            COALESCE(SUM(rider_earnings),0)::numeric(14,2) AS rider_payouts,
            COALESCE(SUM(tax_amount),0)::numeric(14,2) AS tax_collected,
            currency
       FROM shipments ${where}
   GROUP BY bucket, currency ORDER BY bucket ASC`, params
  );
  return ok(rows);
});
