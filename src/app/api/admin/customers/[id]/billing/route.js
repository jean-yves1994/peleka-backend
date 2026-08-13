const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { NotFoundError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';

exports.GET = withHandler(async (request, { params }) => {
  await requireRole(request, ['admin', 'dispatcher']);

  const { rows: [customer] } = await query(
    `SELECT id, email, phone, full_name, customer_type, contract_customer,
            credit_limit, outstanding_balance
       FROM users
      WHERE id=$1 AND role='customer' AND deleted_at IS NULL`,
    [params.id]
  );
  if (!customer) throw new NotFoundError('Customer not found');

  const { rows: shipments } = await query(
    `SELECT s.id, s.tracking_number, s.status, s.total_price, s.currency,
            s.created_at, s.delivered_at,
            COALESCE((SELECT p.status::text FROM payments p
                      WHERE p.shipment_id=s.id
                      ORDER BY p.created_at DESC LIMIT 1), 'unpaid') AS payment_status
       FROM shipments s
      WHERE s.customer_id=$1
      ORDER BY s.created_at DESC`,
    [params.id]
  );

  return ok({
    customer,
    outstanding_balance: Number(customer.outstanding_balance || 0),
    shipments,
  });
});
