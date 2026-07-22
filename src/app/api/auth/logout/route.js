const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { hashToken, verifyRefreshToken } = require('@/lib/jwt');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  const body = await readJson(request).catch(() => ({}));
  if (body?.refresh_token) {
    try {
      const payload = verifyRefreshToken(body.refresh_token);
      await query(`UPDATE refresh_tokens SET revoked_at=NOW()
        WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL`,
        [hashToken(payload.jti), user.id]);
    } catch {}
  } else {
    await query(`UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`, [user.id]);
  }
  await logAudit({ request, actor: user, action: 'auth.logout', entityType: 'user', entityId: user.id });
  return ok({ message: 'Logged out' });
});
