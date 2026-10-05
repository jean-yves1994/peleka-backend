const { query } = require('@/lib/db');
const { hashToken } = require('@/lib/jwt');
const { rateLimit, getClientIp } = require('@/lib/middleware');
const { ok } = require('@/lib/response');
const { BadRequestError, NotFoundError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';

exports.GET = withHandler(async (request, { params }) => {
  rateLimit('guest-payment:' + (getClientIp(request) || 'unknown'), { max: 60, windowMs: 60_000 });
  const token = String(request.headers.get('x-guest-access-token') || '').trim();
  if (!token) throw new BadRequestError('Guest access token is required');
  const { rows } = await query(
    'SELECT p.*, s.tracking_number, s.status AS shipment_status ' +
    'FROM payments p JOIN shipments s ON s.id=p.shipment_id ' +
    'JOIN guest_shipment_access gsa ON gsa.shipment_id=s.id ' +
    'WHERE p.id=$1 AND s.is_guest=TRUE AND p.customer_id IS NULL AND gsa.token_hash=$2 LIMIT 1',
    [params.id, hashToken(token)]
  );
  const p = rows[0];
  if (!p) throw new NotFoundError('Guest payment not found');
  return ok({
    payment_id: p.id, shipment_id: p.shipment_id, tracking_number: p.tracking_number,
    status: p.status, amount: Number(p.amount), currency: p.currency, provider: p.provider,
    provider_ref: p.provider_ref, failure_reason: p.failure_reason, paid_at: p.paid_at,
    shipment_status: p.shipment_status, created_at: p.created_at, updated_at: p.updated_at
  });
});
