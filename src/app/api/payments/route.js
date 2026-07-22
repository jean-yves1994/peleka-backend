const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { createPaymentSchema } = require('@/lib/validation');
const { created } = require('@/lib/response');
const { NotFoundError, ForbiddenError, ConflictError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  const body = createPaymentSchema.parse(await readJson(request));
  const { rows } = await query(`SELECT * FROM shipments WHERE id=$1`, [body.shipment_id]);
  const s = rows[0];
  if (!s) throw new NotFoundError('Shipment not found');
  const isOwner = user.role === 'customer' && s.customer_id === user.id;
  const isAdmin = user.role === 'admin';
  if (!isOwner && !isAdmin) throw new ForbiddenError();
  if (s.status === 'cancelled') throw new ConflictError('Cannot pay for a cancelled shipment');
  const { rows: [p] } = await query(
    `INSERT INTO payments (shipment_id, customer_id, amount, currency, method, status, provider, provider_ref)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7) RETURNING *`,
    [s.id, s.customer_id, s.total_price, s.currency, body.method, body.provider || null, body.provider_ref || null]
  );
  await logAudit({ request, actor: user, action: 'payment.initiated', entityType: 'payment', entityId: p.id });
  return created(p);
});
