const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { parseListParams } = require('@/lib/middleware');
const { paginated } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const { page, pageSize, offset } = parseListParams(request);
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const filters = []; const params = [];
  if (status) { params.push(status); filters.push(`c.status=$${params.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const listParams = [...params, pageSize, offset];
  const { rows } = await query(
    `SELECT c.*, u.full_name AS raised_by_name, u.email AS raised_by_email,
            s.tracking_number
       FROM complaints c JOIN users u ON u.id=c.raised_by
  LEFT JOIN shipments s ON s.id=c.shipment_id
       ${where} ORDER BY c.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams
  );
  const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM complaints c ${where}`, params);
  return paginated(rows, { page, pageSize, total: count });
});
