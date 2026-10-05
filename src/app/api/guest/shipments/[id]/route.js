const { query } = require('@/lib/db');
const { hashToken } = require('@/lib/jwt');
const { rateLimit, getClientIp } = require('@/lib/middleware');
const { ok } = require('@/lib/response');
const { BadRequestError, NotFoundError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';

function guestToken(request) {
  return String(
    request.headers.get('x-guest-access-token') ||
    request.headers.get('X-Guest-Access-Token') ||
    ''
  ).trim();
}

exports.GET = withHandler(async (request, { params }) => {
  rateLimit(\`guest-shipment:\${getClientIp(request) || 'unknown'}\`, { max: 60, windowMs: 60_000 });
  const token = guestToken(request);
  if (!token) throw new BadRequestError('Guest access token is required');

  const tokenHash = hashToken(token);
  const { rows } = await query(
    \`SELECT s.id, s.tracking_number, s.status, s.is_guest,
            s.guest_name, s.guest_phone, s.guest_email,
            s.sender_name, s.sender_phone, s.recipient_name, s.recipient_phone,
            s.pickup_address, s.pickup_city, s.pickup_lat, s.pickup_lng,
            s.delivery_address, s.delivery_city, s.delivery_lat, s.delivery_lng,
            s.parcel_description, s.parcel_category, s.parcel_weight_kg,
            s.parcel_declared_value, s.is_fragile,
            s.distance_km, s.duration_minutes, s.total_price, s.currency,
            s.created_at, s.updated_at, s.picked_up_at, s.delivered_at,
            gsa.token_hash,
            COALESCE((SELECT p.status::text FROM payments p WHERE p.shipment_id=s.id ORDER BY p.created_at DESC LIMIT 1),'unpaid') AS payment_status,
            (SELECT p.id FROM payments p WHERE p.shipment_id=s.id ORDER BY p.created_at DESC LIMIT 1) AS payment_id
       FROM shipments s
       JOIN guest_shipment_access gsa ON gsa.shipment_id=s.id
      WHERE s.id=$1 AND s.is_guest=TRUE AND gsa.token_hash=$2\`,
    [params.id, tokenHash]
  );
  const s = rows[0];
  if (!s) throw new NotFoundError('Guest shipment not found');

  const { rows: timeline } = await query(
    \`SELECT to_status::text AS status, note, created_at
       FROM shipment_status_history WHERE shipment_id=$1 ORDER BY created_at ASC\`,
    [s.id]
  );

  delete s.token_hash;
  return ok({ shipment: s, timeline });
});
