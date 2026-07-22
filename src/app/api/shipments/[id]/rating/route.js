const { withTransaction } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { rateShipmentSchema } = require('@/lib/validation');
const { created } = require('@/lib/response');
const { NotFoundError, ForbiddenError, ConflictError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const body = rateShipmentSchema.parse(await readJson(request));
  const rating = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT id, customer_id, rider_id, status FROM shipments WHERE id=$1 FOR UPDATE`, [params.id]);
    const s = rows[0];
    if (!s) throw new NotFoundError('Shipment not found');
    if (s.customer_id !== user.id) throw new ForbiddenError('Only the customer can rate this shipment');
    if (s.status !== 'delivered') throw new ConflictError('You can only rate delivered shipments');
    if (!s.rider_id) throw new ConflictError('Shipment has no assigned rider');
    const existing = await client.query(`SELECT 1 FROM ratings WHERE shipment_id=$1`, [s.id]);
    if (existing.rowCount > 0) throw new ConflictError('This shipment has already been rated');
    const { rows: [r] } = await client.query(
      `INSERT INTO ratings (shipment_id, customer_id, rider_id, score, comment)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [s.id, s.customer_id, s.rider_id, body.score, body.comment || null]
    );
    return r;
  });
  await logAudit({ request, actor: user, action: 'shipment.rated', entityType: 'shipment', entityId: params.id, data: { score: body.score } });
  return created(rating);
});
