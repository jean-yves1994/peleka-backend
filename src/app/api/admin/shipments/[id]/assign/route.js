const { withTransaction } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { assignShipmentSchema } = require('@/lib/validation');
const { created } = require('@/lib/response');
const { NotFoundError, ConflictError, BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { notify } = require('@/lib/notifications');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin','dispatcher']);
  const body = assignShipmentSchema.parse(await readJson(request));
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM shipments WHERE id=$1 FOR UPDATE`, [params.id]);
    const s = rows[0];
    if (!s) throw new NotFoundError('Shipment not found');
    if (!['awaiting_assignment','pending_payment','draft'].includes(s.status))
      throw new ConflictError(`Cannot offer assignment for status "${s.status}"`);

    // Standard customers must pay before a dispatcher can offer the shipment.
    // Premier customers are explicitly allowed to be dispatched while their
    // payment remains outstanding. Keep this rule in the backend as well as
    // the admin UI so the API cannot be bypassed.
    if (s.status === 'pending_payment') {
      const { rows: [customer] } = await client.query(
        `SELECT customer_type, contract_customer
           FROM users WHERE id=$1 AND role='customer'`,
        [s.customer_id],
      );
      const premier = customer?.customer_type === 'premier' || customer?.contract_customer === true;
      if (!premier) {
        throw new ConflictError('Standard customer shipment cannot be assigned until payment is completed');
      }
    }
    const rider = await client.query(
      `SELECT u.id, u.status AS account_status, rp.status AS rider_status
         FROM users u JOIN rider_profiles rp ON rp.user_id=u.id
        WHERE u.id=$1 AND u.role='rider'`, [body.rider_id]
    );
    if (rider.rowCount === 0) throw new NotFoundError('Rider not found');
    if (rider.rows[0].account_status !== 'active') throw new BadRequestError('Rider account is not active');
    if (!['approved','online','busy'].includes(rider.rows[0].rider_status))
      throw new BadRequestError(`Rider status "${rider.rows[0].rider_status}" is not eligible`);
    const expiresIn = (body.expires_in_minutes || 15) * 60 * 1000;
    const { rows: [assignment] } = await client.query(
      `INSERT INTO shipment_assignments (shipment_id, rider_id, assigned_by, status, expires_at)
       VALUES ($1,$2,$3,'offered', NOW() + ($4::int * INTERVAL '1 millisecond'))
       RETURNING *`,
      [s.id, body.rider_id, admin.id, expiresIn]
    );
    return { shipment: s, assignment };
  });
  await logAudit({ request, actor: admin, action: 'shipment.assignment.offered',
    entityType: 'shipment', entityId: params.id, data: { rider_id: body.rider_id } });
  try {
    await notify({ userId: body.rider_id, title: 'New delivery offer',
      body: `Pickup at ${result.shipment.pickup_address}`,
      data: { type: 'assignment.offered', shipment_id: result.shipment.id, assignment_id: result.assignment.id } });
  } catch(_) {}
  return created(result);
});
