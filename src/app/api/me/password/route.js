const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { changePasswordSchema } = require('@/lib/validation');
const { hashPassword, verifyPassword } = require('@/lib/password');
const { ok } = require('@/lib/response');
const { UnauthorizedError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  const body = changePasswordSchema.parse(await readJson(request));
  const { rows } = await query(`SELECT password_hash FROM users WHERE id=$1`, [user.id]);
  const ok1 = await verifyPassword(body.current_password, rows[0]?.password_hash);
  if (!ok1) throw new UnauthorizedError('Current password is incorrect');
  const password_hash = await hashPassword(body.new_password);
  await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [password_hash, user.id]);
  await query(`UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`, [user.id]);
  await logAudit({ request, actor: user, action: 'user.password_changed', entityType: 'user', entityId: user.id });
  return ok({ message: 'Password updated. Please sign in again on other devices.' });
});
