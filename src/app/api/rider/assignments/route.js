const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { parseListParams } = require('@/lib/middleware');
const { paginated } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request) => {
  const user = await requireRole(request, ['rider']);
  const { page, pageSize, offset } = parseListParams(request);
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'offered';
  const { rows } = await query(
    `SELECT sa.*, row_to_json(s.*) AS shipment FROM shipment_assignments sa
       JOIN shipments s ON s.id=sa.shipment_id
      WHERE sa.rider_id=$1 AND sa.status=$2
      ORDER BY sa.offered_at DESC LIMIT $3 OFFSET $4`,
    [user.id, status, pageSize, offset]
  );
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM shipment_assignments WHERE rider_id=$1 AND status=$2`, [user.id, status]
  );
  return paginated(rows, { page, pageSize, total: count });
});
