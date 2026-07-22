const { query } = require('@/lib/db');
const { requireAuth } = require('@/lib/auth');
const { parseListParams } = require('@/lib/middleware');
const { paginated, ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request) => {
  const user = await requireAuth(request);
  const { page, pageSize, offset } = parseListParams(request);
  const url = new URL(request.url);
  const unreadOnly = url.searchParams.get('unread') === 'true';
  const where = unreadOnly ? 'AND read_at IS NULL' : '';
  const { rows } = await query(
    `SELECT * FROM notifications WHERE user_id=$1 ${where}
      ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [user.id, pageSize, offset]
  );
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id=$1 ${where}`, [user.id]
  );
  return paginated(rows, { page, pageSize, total: count });
});
exports.PATCH = withHandler(async (request) => {
  const user = await requireAuth(request);
  await query(`UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL`, [user.id]);
  return ok({ message: 'All notifications marked as read' });
});
