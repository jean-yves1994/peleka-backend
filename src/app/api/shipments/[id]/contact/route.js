/**
 * GET /api/shipments/:id/contact
 * Returns phone numbers of the counterpart(s), gated by:
 *   - Rider: must be assigned + shipment active → gets customer/sender/recipient
 *   - Customer: must own shipment + active → gets rider (if assigned)
 *   - Admin/Dispatcher: sees everyone always
 * All lookups are audited in contact_access_logs.
 */
const { query } = require('@/lib/db');
const { requireAuth } = require('@/lib/auth');
const { getClientIp, getUserAgent } = require('@/lib/middleware');
const { ok } = require('@/lib/response');
const { NotFoundError, ForbiddenError, ConflictError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
const ACTIVE_STATUSES = new Set([
  'assigned','rider_en_route_to_pickup','picked_up','in_transit','out_for_delivery',
]);

exports.GET = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const { rows: shipRows } = await query(
    `SELECT s.id, s.status, s.customer_id, s.rider_id,
            s.sender_name, s.sender_phone,
            s.recipient_name, s.recipient_phone,
            cu.full_name AS customer_name, cu.phone AS customer_phone,
            ru.full_name AS rider_name, ru.phone AS rider_phone,
            s.tracking_number
       FROM shipments s
       JOIN users cu ON cu.id = s.customer_id
  LEFT JOIN users ru ON ru.id = s.rider_id
      WHERE s.id=$1`, [params.id]
  );
  const s = shipRows[0];
  if (!s) throw new NotFoundError('Shipment not found');
  const isAdmin = user.role === 'admin' || user.role === 'dispatcher';
  const isCustomer = user.role === 'customer' && s.customer_id === user.id;
  const isRider = user.role === 'rider' && s.rider_id === user.id;
  if (!isAdmin && !isCustomer && !isRider) throw new ForbiddenError();
  if (!isAdmin && !ACTIVE_STATUSES.has(s.status)) {
    throw new ConflictError(`Contact info is only available while the shipment is active (current status: ${s.status})`);
  }

  const payload = { shipment_id: s.id, tracking_number: s.tracking_number, status: s.status };
  const accessedRoles = [];
  if (isRider) {
    payload.customer  = { name: s.customer_name,  phone: s.customer_phone };
    payload.sender    = { name: s.sender_name,    phone: s.sender_phone };
    payload.recipient = { name: s.recipient_name, phone: s.recipient_phone };
    accessedRoles.push('customer','sender','recipient');
  } else if (isCustomer) {
    if (s.rider_id) { payload.rider = { name: s.rider_name, phone: s.rider_phone }; accessedRoles.push('rider'); }
    else payload.rider = null;
  } else if (isAdmin) {
    payload.customer  = { name: s.customer_name,  phone: s.customer_phone };
    payload.sender    = { name: s.sender_name,    phone: s.sender_phone };
    payload.recipient = { name: s.recipient_name, phone: s.recipient_phone };
    if (s.rider_id) payload.rider = { name: s.rider_name, phone: s.rider_phone };
    accessedRoles.push('customer','sender','recipient');
    if (s.rider_id) accessedRoles.push('rider');
  }
  await Promise.all(accessedRoles.map(target =>
    query(`INSERT INTO contact_access_logs (shipment_id, accessed_by, actor_role, target_role, ip_address, user_agent)
           VALUES ($1,$2,$3,$4,$5,$6)`,
      [s.id, user.id, user.role, target, getClientIp(request), getUserAgent(request)]
    ).catch(() => null)
  ));
  return ok(payload);
});
