const { withTransaction, query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { NotFoundError, BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { customerAccountSchema } = require('@/lib/validation');

exports.dynamic = 'force-dynamic';

/**
 * PATCH /api/admin/customers/:id
 * Promote/demote a customer between standard and premier and optionally set
 * the approved credit limit. `contract_customer` is kept synchronized for
 * backwards compatibility with older clients/data.
 */
exports.PATCH = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin']);
  const body = customerAccountSchema.parse(await readJson(request));

  const updated = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT id, role, outstanding_balance FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [params.id]
    );
    const customer = existing[0];
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.role !== 'customer') throw new BadRequestError('Only customer accounts can be changed');

    const creditLimit = body.credit_limit !== undefined
      ? Number(body.credit_limit)
      : null;

    if (creditLimit !== null && creditLimit < Number(customer.outstanding_balance || 0)) {
      throw new BadRequestError('Credit limit cannot be below the current outstanding balance');
    }

    const { rows } = await client.query(
      `UPDATE users
          SET customer_type=$2::varchar(20),
              contract_customer=($2::varchar(20)='premier'),
              credit_limit=COALESCE($3, credit_limit),
              updated_at=NOW()
        WHERE id=$1
        RETURNING id, email, phone, full_name, role, status,
                  customer_type, contract_customer, credit_limit, outstanding_balance,
                  created_at, updated_at`,
      [params.id, body.customer_type, creditLimit]
    );
    return rows[0];
  });

  await logAudit({
    request, actor: admin, action: 'customer.account_type_updated',
    entityType: 'user', entityId: params.id,
    data: { customer_type: updated.customer_type, credit_limit: updated.credit_limit },
  });

  return ok(updated);
});

exports.GET = withHandler(async (request, { params }) => {
  await requireRole(request, ['admin', 'dispatcher']);
  const { rows } = await query(
    `SELECT id, email, phone, full_name, role, status,
            customer_type, contract_customer, credit_limit, outstanding_balance,
            created_at, updated_at
       FROM users WHERE id=$1 AND role='customer' AND deleted_at IS NULL`,
    [params.id]
  );
  if (!rows[0]) throw new NotFoundError('Customer not found');
  return ok(rows[0]);
});
