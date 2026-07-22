const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { parseListParams } = require('@/lib/middleware');
const { paginated } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const { page, pageSize, offset, q, sortCol, sortDir } = parseListParams(request);
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const rider_id = url.searchParams.get('rider_id');
  const customer_id = url.searchParams.get('customer_id');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const filters = []; const params = [];
  if (status) { params.push(status); filters.push(`s.status=$${params.length}::shipment_status`); }
  if (rider_id) { params.push(rider_id); filters.push(`s.rider_id=$${params.length}`); }
  if (customer_id) { params.push(customer_id); filters.push(`s.customer_id=$${params.length}`); }
  if (from) { params.push(from); filters.push(`s.created_at >= $${params.length}`); }
  if (to) { params.push(to); filters.push(`s.created_at < $${params.length}::date + INTERVAL '1 day'`); }
  if (q) { params.push(`%${q}%`); filters.push(`(s.tracking_number ILIKE $${params.length} OR s.sender_name ILIKE $${params.length} OR s.recipient_name ILIKE $${params.length})`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const allowed = new Set(['created_at','total_price','distance_km','status']);
  const orderBy = allowed.has(sortCol) ? sortCol : 'created_at';
  const listParams = [...params, pageSize, offset];
  const { rows } = await query(
    `SELECT s.*, cu.full_name AS customer_name, cu.phone AS customer_phone,
            ru.full_name AS rider_name, ru.phone AS rider_phone
       FROM shipments s JOIN users cu ON cu.id=s.customer_id
  LEFT JOIN users ru ON ru.id=s.rider_id
       ${where} ORDER BY s.${orderBy} ${sortDir}
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams
  );
  const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM shipments s ${where}`, params);
  return paginated(rows, { page, pageSize, total: count });
});
