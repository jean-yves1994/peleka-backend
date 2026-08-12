const { query } = require('@/lib/db');
const { requireAuth } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { ForbiddenError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

/**
 * GET /api/rider/open-shipments — the job pool.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FILTER THAT MATTERS: STATUS, NOT PAYMENTS
 *
 * A shipment is claimable when it's 'awaiting_assignment' with no rider. It
 * reaches that state two ways:
 *
 *   · a normal customer paid        → the Paypack webhook moved it
 *   · a contract customer created it → invoice terms, no payment row at all
 *
 * Both are genuinely ready. Do NOT join `payments` to check for a paid row —
 * contract shipments have none, so every one of them would vanish from every
 * rider's screen. Filtering on status covers both cases, and 'pending_payment'
 * shipments never appear, so unpaid work is never offered.
 *
 * Customer phone numbers are deliberately withheld here and only returned once
 * a rider has actually claimed the job.
 */

exports.dynamic = 'force-dynamic';

exports.GET = withHandler(async (request) => {
  const rider = await requireAuth(request);
  if (rider.role !== 'rider') throw new ForbiddenError('Riders only');

  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 30)));

  // How much is this rider already carrying? The app uses it to disable Accept
  // rather than letting them tap and get a 409.
  const { rows: [active] } = await query(
    `SELECT COUNT(*)::int AS n FROM shipments
      WHERE rider_id = $1
        AND status IN ('rider_en_route_to_pickup','picked_up','in_transit','out_for_delivery')`,
    [rider.id]
  );

  const { rows } = await query(
    `SELECT s.id, s.tracking_number, s.created_at,
            s.pickup_address, s.pickup_city, s.pickup_lat, s.pickup_lng, s.pickup_notes,
            s.delivery_address, s.delivery_city, s.delivery_lat, s.delivery_lng,
            s.parcel_description, s.parcel_category, s.parcel_weight_kg,
            s.is_fragile, s.requires_signature,
            s.distance_km, s.duration_minutes,
            s.total_price, s.currency, s.rider_earnings,
            COALESCE((SELECT p.status FROM payments p
                      WHERE p.shipment_id=s.id ORDER BY p.created_at DESC LIMIT 1), 'unpaid') AS payment_status,
            cu.customer_type
       FROM shipments s
       JOIN users cu ON cu.id=s.customer_id
      WHERE s.rider_id IS NULL
        AND s.status = 'awaiting_assignment'
        AND (
          cu.customer_type = 'premier'
          OR cu.contract_customer = TRUE
          OR EXISTS (
            SELECT 1 FROM payments p
             WHERE p.shipment_id=s.id AND p.status='paid'
          )
        )
      ORDER BY s.created_at ASC
      LIMIT $1`,
    [limit]
  );

  return ok(rows, { total: rows.length, active_deliveries: active.n });
});
