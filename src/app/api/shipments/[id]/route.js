const { query } = require('@/lib/db');
const { requireAuth } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { NotFoundError, ForbiddenError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const { rows } = await query(`SELECT * FROM shipments WHERE id=$1`, [params.id]);
  const shipment = rows[0];
  if (!shipment) throw new NotFoundError('Shipment not found');
  const isOwner = user.role === 'customer' && shipment.customer_id === user.id;
  const isAssigned = user.role === 'rider' && shipment.rider_id === user.id;
  const isAdmin = user.role === 'admin' || user.role === 'dispatcher';
  if (!isOwner && !isAssigned && !isAdmin) throw new ForbiddenError();

  const [history, proofs, rating, payments] = await Promise.all([
    query(`SELECT * FROM shipment_status_history WHERE shipment_id=$1 ORDER BY created_at ASC`, [params.id]),
    query(`SELECT * FROM shipment_proofs         WHERE shipment_id=$1 ORDER BY captured_at ASC`, [params.id]),
    query(`SELECT * FROM ratings                 WHERE shipment_id=$1`, [params.id]),
    query(`SELECT * FROM payments                WHERE shipment_id=$1 ORDER BY created_at ASC`, [params.id]),
  ]);
  return ok({
    shipment, status_history: history.rows, proofs: proofs.rows,
    rating: rating.rows[0] || null, payments: payments.rows,
  });
});
