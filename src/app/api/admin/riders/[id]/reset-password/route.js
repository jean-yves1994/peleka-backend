const { withTransaction } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { hashPassword, isPasswordStrong } = require('@/lib/password');
const { ok } = require('@/lib/response');
const { NotFoundError, BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin']);
  const body = await readJson(request).catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';
  if (!isPasswordStrong(password)) {
    throw new BadRequestError('Password must be at least 8 characters and include a letter and a number');
  }

  const password_hash = await hashPassword(password);
  const rider = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, email, phone, full_name, role, status FROM users
       WHERE id=$1 AND role='rider' AND deleted_at IS NULL FOR UPDATE`,
      [params.id]
    );
    if (!rows[0]) throw new NotFoundError('Rider not found');

    await client.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [password_hash, params.id]);
    await client.query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [params.id]);
    return rows[0];
  });

  await logAudit({ request, actor: admin, action: 'rider.password_reset_by_admin', entityType: 'user', entityId: rider.id });
  return ok({ message: 'Rider password reset successfully. Existing sessions have been signed out.', rider });
});
