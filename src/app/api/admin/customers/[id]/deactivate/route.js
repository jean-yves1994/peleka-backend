const { withTransaction } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { NotFoundError, BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin']);

  const customer = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, email, phone, full_name, role, status FROM users
       WHERE id=$1 AND role='customer' AND deleted_at IS NULL FOR UPDATE`,
      [params.id]
    );
    if (!rows[0]) throw new NotFoundError('Customer not found');
    if (rows[0].status === 'suspended') throw new BadRequestError('Customer account is already deactivated');

    const { rows: updated } = await client.query(
      `UPDATE users SET status='suspended', updated_at=NOW() WHERE id=$1
       RETURNING id, email, phone, full_name, role, status, updated_at`,
      [params.id]
    );
    await client.query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [params.id]);
    return updated[0];
  });

  await logAudit({ request, actor: admin, action: 'customer.deactivated', entityType: 'user', entityId: customer.id });
  return ok({ message: 'Customer account deactivated successfully.', customer });
});
