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
    `SELECT id, tracking_number, created_at,
            pickup_address, pickup_city, pickup_lat, pickup_lng, pickup_notes,
            delivery_address, delivery_city, delivery_lat, delivery_lng,
            parcel_description, parcel_category, parcel_weight_kg,
            is_fragile, requires_signature,
            distance_km, duration_minutes,
            total_price, currency, rider_earnings
       FROM shipments
      WHERE rider_id IS NULL
        AND status = 'awaiting_assignment'
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit]
  );

  return ok(rows, { total: rows.length, active_deliveries: active.n });
});
