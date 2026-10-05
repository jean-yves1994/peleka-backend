const { query } = require('@/lib/db');
const { rateLimit, getClientIp } = require('@/lib/middleware');
const { ok } = require('@/lib/response');
const { NotFoundError, ForbiddenError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request, { params }) => {
  rateLimit(`track:${getClientIp(request) || 'unknown'}`, { max: 60, windowMs: 60_000 });
  const url = new URL(request.url);
  const guestAccessToken = String(url.searchParams.get('guest_access_token') || '').trim();
  const { rows } = await query(
    `SELECT id, tracking_number, status, is_guest, pickup_city, delivery_city,
            split_part(recipient_name, ' ', 1) AS recipient_first_name,
            picked_up_at, delivered_at, created_at
       FROM shipments WHERE tracking_number=$1`, [params.trackingNumber]
  );
  const s = rows[0];
  if (!s) throw new NotFoundError('Tracking number not found');
  if (s.is_guest) {
    if (!guestAccessToken) throw new ForbiddenError('Guest access token is required');
    const { rows: accessRows } = await query(`SELECT 1 FROM guest_shipment_access WHERE shipment_id=$1 AND token_hash=$2`, [s.id, require('@/lib/jwt').hashToken(guestAccessToken)]);
    if (accessRows.length === 0) throw new ForbiddenError('Invalid guest access token');
  }
  const { rows: history } = await query(
    `SELECT to_status::text AS status, note, created_at
       FROM shipment_status_history WHERE shipment_id=$1 ORDER BY created_at ASC`,
    [s.id]
  );
  return ok({ shipment: s, timeline: history });
});
