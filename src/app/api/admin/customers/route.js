const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { parseListParams } = require('@/lib/middleware');
const { paginated } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const { page, pageSize, offset, q } = parseListParams(request);
  const filters = [`u.role='customer'`, `u.deleted_at IS NULL`];
  const params = [];
  if (q) { params.push(`%${q}%`); filters.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`); }
  const where = `WHERE ${filters.join(' AND ')}`;
  const listParams = [...params, pageSize, offset];
  const { rows } = await query(
    `SELECT u.id, u.email, u.phone, u.full_name, u.status, u.created_at, u.last_login_at,
            cp.wallet_balance,
            (SELECT COUNT(*)::int FROM shipments s WHERE s.customer_id=u.id) AS shipment_count
       FROM users u LEFT JOIN customer_profiles cp ON cp.user_id=u.id
       ${where} ORDER BY u.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams
  );
  const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM users u ${where}`, params);
  return paginated(rows, { page, pageSize, total: count });
});
