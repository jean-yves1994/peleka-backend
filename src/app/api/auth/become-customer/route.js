const { withTransaction } = require('@/lib/db');
const { requireAuth } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);

  const result = await withTransaction(async (client) => {
    const { rows: [profile] } = await client.query(
      `INSERT INTO customer_profiles (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING *`,
      [user.id]
    );

    const { rows: [updated] } = await client.query(
      `SELECT id, email, phone, full_name, role, status, avatar_url, created_at,
              customer_type, contract_customer, credit_limit, outstanding_balance
         FROM users WHERE id=$1`,
      [user.id]
    );

    return { user: updated, customer_profile: profile };
  });

  await logAudit({
    request,
    actor: user,
    action: 'auth.customer_enabled',
    entityType: 'user',
    entityId: user.id,
    data: { previous_role: user.role },
  });

  return ok({
    ...result,
    message: 'Customer access enabled for this Peleka account',
  });
});
