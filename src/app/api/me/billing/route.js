const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';

/**
 * GET /api/me/billing
 * Premier customers can see what they owe and which shipments make up the
 * balance. Standard customers receive a zero outstanding balance.
 */
exports.GET = withHandler(async (request) => {
  const user = await requireRole(request, ['customer']);

  const { rows: [account] } = await query(
    `SELECT customer_type, contract_customer, credit_limit, outstanding_balance
       FROM users WHERE id=$1`,
    [user.id]
  );

  const { rows: shipments } = await query(
    `SELECT s.id, s.tracking_number, s.status, s.total_price, s.currency,
            s.created_at, s.delivered_at,
            COALESCE((SELECT p.status::text FROM payments p
                      WHERE p.shipment_id=s.id
                      ORDER BY p.created_at DESC LIMIT 1), 'unpaid') AS payment_status
       FROM shipments s
      WHERE s.customer_id=$1
        AND (s.customer_id IS NOT NULL)
        AND (s.status <> 'cancelled' OR EXISTS (
          SELECT 1 FROM payments p WHERE p.shipment_id=s.id AND p.status='paid'
        ))
      ORDER BY s.created_at DESC`,
    [user.id]
  );

  return ok({
    customer_type: account?.customer_type || (account?.contract_customer ? 'premier' : 'standard'),
    credit_limit: Number(account?.credit_limit || 0),
    outstanding_balance: Number(account?.outstanding_balance || 0),
    outstanding_shipments: shipments.filter(s => s.payment_status !== 'paid')
      .map(s => ({ ...s, total_price: Number(s.total_price) })),
    shipment_history: shipments,
  });
});
