const { withTransaction, query } = require('@/lib/db');
const { readJson, rateLimit, getClientIp } = require('@/lib/middleware');
const { resetPasswordSchema } = require('@/lib/validation');
const { hashPassword } = require('@/lib/password');
const { hashToken } = require('@/lib/jwt');
const { ok } = require('@/lib/response');
const { BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  rateLimit(`reset:${getClientIp(request) || 'unknown'}`, { max: 10, windowMs: 60_000 });
  const { token, password } = resetPasswordSchema.parse(await readJson(request));
  const { rows } = await query(`SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash=$1`, [hashToken(token)]);
  const pr = rows[0];
  if (!pr) throw new BadRequestError('Invalid reset token');
  if (pr.used_at) throw new BadRequestError('Reset token already used');
  if (new Date(pr.expires_at) < new Date()) throw new BadRequestError('Reset token expired');
  const password_hash = await hashPassword(password);
  await withTransaction(async (client) => {
    await client.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [password_hash, pr.user_id]);
    await client.query(`UPDATE password_resets SET used_at=NOW() WHERE id=$1`, [pr.id]);
    await client.query(`UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`, [pr.user_id]);
  });
  await logAudit({ request, actor: { id: pr.user_id }, action: 'auth.password_reset', entityType: 'user', entityId: pr.user_id });
  return ok({ message: 'Password reset successful. Please sign in again.' });
});
