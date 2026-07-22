const { withTransaction } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { NotFoundError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { notify } = require('@/lib/notifications');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin']);
  const body = await readJson(request).catch(() => ({}));
  const reason = (body && body.reason) || null;
  const result = await withTransaction(async (client) => {
    const { rows: [profile] } = await client.query(
      `UPDATE rider_profiles SET status='suspended' WHERE user_id=$1 RETURNING *`, [params.id]
    );
    if (!profile) throw new NotFoundError('Rider profile not found');
    await client.query(`UPDATE users SET status='suspended' WHERE id=$1`, [params.id]);
    await client.query(`UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`, [params.id]);
    return profile;
  });
  await logAudit({ request, actor: admin, action: 'rider.suspended', entityType: 'user', entityId: params.id, data: { reason } });
  try { await notify({ userId: params.id, title: 'Account suspended', body: reason || 'Your account has been suspended', data: { type: 'rider.suspended' } }); } catch(_) {}
  return ok(result);
});
