const { query } = require('@/lib/db');
const { requireAuth } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { NotFoundError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.PATCH = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const { rowCount } = await query(
    `UPDATE notifications SET read_at=NOW() WHERE id=$1 AND user_id=$2 AND read_at IS NULL`,
    [params.id, user.id]
  );
  if (rowCount === 0) throw new NotFoundError('Notification not found or already read');
  return ok({ message: 'Marked as read' });
});
