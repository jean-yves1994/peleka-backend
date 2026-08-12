const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { parseListParams } = require('@/lib/middleware');
const { paginated } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin']);
  const { page, pageSize, offset, q } = parseListParams(request);
  const url = new URL(request.url);
  const role = url.searchParams.get('role');
  const filters = ['deleted_at IS NULL'];
  const params = [];
  if (role) { params.push(role); filters.push(`role=$${params.length}::user_role`); }
  if (q) { params.push(`%${q}%`); filters.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`); }
  const where = `WHERE ${filters.join(' AND ')}`;
  const listParams = [...params, pageSize, offset];
  const { rows } = await query(
    `SELECT id, email, phone, full_name, role, status, avatar_url, created_at, last_login_at,
              customer_type, contract_customer, credit_limit, outstanding_balance
       FROM users ${where} ORDER BY created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams
  );
  const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM users ${where}`, params);
  return paginated(rows, { page, pageSize, total: count });
});
