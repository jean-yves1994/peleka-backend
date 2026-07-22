const { withTransaction } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { NotFoundError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { notify } = require('@/lib/notifications');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin']);
  const result = await withTransaction(async (client) => {
    const { rows: [profile] } = await client.query(
      `UPDATE rider_profiles SET status='approved', approved_by=$2, approved_at=NOW()
        WHERE user_id=$1 RETURNING *`, [params.id, admin.id]
    );
    if (!profile) throw new NotFoundError('Rider profile not found');
    return profile;
  });
  await logAudit({ request, actor: admin, action: 'rider.approved', entityType: 'user', entityId: params.id });
  try { await notify({ userId: params.id, title: 'Account approved', body: 'You can now accept deliveries', data: { type: 'rider.approved' } }); } catch(_) {}
  return ok(result);
});
