const crypto = require('crypto');
const { readJson, parseListParams } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { createShipmentSchema } = require('@/lib/validation');
const { quoteShipment } = require('@/lib/pricing');
const { ok, created, paginated } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { query, withTransaction } = require('@/lib/db');
const { BadRequestError, NotFoundError } = require('@/lib/errors');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

function makeTrackingNumber() {
  return `PLK-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * GET /api/shipments
 *
 * Customer shipment list. The broken backend only exported POST from this
 * route, which is why the customer portal received HTTP 405 for:
 * GET /api/shipments?pageSize=100
 */
exports.GET = withHandler(async (request) => {
  const user = await requireRole(request, ['customer']);
  const { page, pageSize, offset } = parseListParams(request);
  const url = new URL(request.url);
  const status = (url.searchParams.get('status') || '').trim();
  const q = (url.searchParams.get('q') || '').trim();

  const filters = ['s.customer_id = $1'];
  const params = [user.id];

  if (status) {
    params.push(status);
    filters.push(`s.status = $${params.length}::shipment_status`);
  }

  if (q) {
    params.push(`%${q}%`);
    filters.push(
      `(s.tracking_number ILIKE $${params.length}
        OR s.pickup_address ILIKE $${params.length}
        OR s.delivery_address ILIKE $${params.length})`,
    );
  }

  const where = filters.join(' AND ');

  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM shipments s WHERE ${where}`,
    params,
  );

  const listParams = [...params, pageSize, offset];
  const { rows } = await query(
    `SELECT s.*,
            COALESCE((
              SELECT p.status::text
                FROM payments p
               WHERE p.shipment_id=s.id
               ORDER BY p.created_at DESC
               LIMIT 1
            ), 'unpaid') AS payment_status,
            CASE
              WHEN cu.customer_type='premier' OR cu.contract_customer=TRUE
              THEN 'premier'
              ELSE 'standard'
            END AS customer_type
       FROM shipments s
       JOIN users cu ON cu.id=s.customer_id
      WHERE ${where}
      ORDER BY s.created_at DESC
      LIMIT $${listParams.length - 1}
      OFFSET $${listParams.length}`,
    listParams,
  );

  return paginated(rows, {
    page,
    pageSize,
    total: Number(count || 0),
  });
});

/**
 * POST /api/shipments
 *
 * Creates the shipment after recalculating the price and driving distance on
 * the server. The browser's quote is never trusted.
 */
exports.POST = withHandler(async (request) => {
  const user = await requireRole(request, ['customer']);
  const body = createShipmentSchema.parse(await readJson(request));

  if (body.pickup_lat === body.delivery_lat && body.pickup_lng === body.delivery_lng) {
    throw new BadRequestError('Pickup and delivery locations must be different.');
  }

  // SERVER-AUTHORITATIVE QUOTE.
  // This is intentionally recalculated at creation time so a modified browser
  // request cannot submit a cheaper distance/total than the current pricing.
  const quote = await quoteShipment({
    pickup_lat: body.pickup_lat,
    pickup_lng: body.pickup_lng,
    delivery_lat: body.delivery_lat,
    delivery_lng: body.delivery_lng,
    pickup_city: body.pickup_city,
    delivery_city: body.delivery_city,
    discount_code: body.discount_code,
  });

  const result = await withTransaction(async (client) => {
    const { rows: [customer] } = await client.query(
      `SELECT id, customer_type, contract_customer, credit_limit, outstanding_balance
         FROM users
        WHERE id=$1 AND role='customer' AND deleted_at IS NULL
        FOR UPDATE`,
      [user.id],
    );

    if (!customer) throw new NotFoundError('Customer account not found');

    const isPremier =
      customer.customer_type === 'premier' || customer.contract_customer === true;

    const outstanding = Number(customer.outstanding_balance || 0);
    const newOutstanding = outstanding + Number(quote.total_price || 0);

    if (
      isPremier &&
      customer.credit_limit != null &&
      newOutstanding > Number(customer.credit_limit)
    ) {
      const available = Math.max(
        0,
        Number(customer.credit_limit) - outstanding,
      );
      throw new BadRequestError(
        `This shipment would exceed your approved credit limit. Available credit: ${available.toFixed(0)} RWF`,
      );
    }

    const status = isPremier ? 'awaiting_assignment' : 'pending_payment';
    const tracking = makeTrackingNumber();

    const { rows: [shipment] } = await client.query(
      `INSERT INTO shipments (
        customer_id, tracking_number, status,
        sender_name, sender_phone, recipient_name, recipient_phone,
        pickup_address, pickup_city, pickup_lat, pickup_lng, pickup_notes, pickup_scheduled_at,
        delivery_address, delivery_city, delivery_lat, delivery_lng, delivery_notes, delivery_scheduled_at,
        parcel_description, parcel_category, parcel_weight_kg,
        parcel_length_cm, parcel_width_cm, parcel_height_cm,
        parcel_declared_value, is_fragile,
        pricing_config_id, currency,
        distance_km, duration_minutes, distance_source,
        base_fare, distance_fee, weight_fee, time_fee, subtotal,
        discount_code, discount_amount, tax_amount, total_price,
        surge_multiplier, rider_earnings, moto_earnings, platform_earnings,
        rider_commission_percentage, moto_commission_percentage,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,
        $4,$5,$6,$7,
        $8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,$18,$19,
        $20,$21,$22,
        $23,$24,$25,
        $26,$27,
        $28,$29,
        $30,$31,$32,
        $33,$34,$35,$36,$37,
        $38,$39,$40,$41,
        $42,$43,$44,$45,
        $46,$47,
        NOW(),NOW()
      )
      RETURNING *`,
      [
        user.id, tracking, status,
        body.sender_name, body.sender_phone,
        body.recipient_name, body.recipient_phone,
        body.pickup_address, body.pickup_city || null,
        body.pickup_lat, body.pickup_lng,
        body.pickup_notes || null, body.pickup_scheduled_at || null,
        body.delivery_address, body.delivery_city || null,
        body.delivery_lat, body.delivery_lng,
        body.delivery_notes || null, body.delivery_scheduled_at || null,
        body.parcel_description, body.parcel_category || null,
        body.parcel_weight_kg ?? 1,
        body.parcel_length_cm ?? null,
        body.parcel_width_cm ?? null,
        body.parcel_height_cm ?? null,
        body.parcel_declared_value ?? null,
        body.is_fragile ?? false,
        quote.pricing_config_id, quote.currency,
        quote.distance_km, quote.duration_minutes, quote.distance_source,
        quote.base_fare, quote.distance_fee, quote.weight_fee,
        quote.time_fee, quote.subtotal,
        quote.discount_code, quote.discount_amount,
        quote.tax_amount, quote.total_price,
        quote.surge_multiplier,
        quote.rider_earnings, quote.moto_earnings,
        quote.platform_earnings,
        quote.rider_commission_percentage,
        quote.moto_commission_percentage,
      ],
    );

    await client.query(
      `INSERT INTO shipment_status_history
         (shipment_id, from_status, to_status, changed_by, note)
       VALUES ($1, NULL, $2, $3, $4)`,
      [
        shipment.id,
        status,
        user.id,
        isPremier
          ? 'Premier shipment created — payment due after delivery'
          : 'Shipment created — payment required',
      ],
    );

    if (isPremier) {
      await client.query(
        `UPDATE users
            SET outstanding_balance=COALESCE(outstanding_balance,0)+$2,
                updated_at=NOW()
          WHERE id=$1`,
        [user.id, quote.total_price],
      );
    }

    return {
      shipment,
      payment_required: !isPremier,
    };
  });

  await logAudit({
    request,
    actor: user,
    action: 'shipment.created',
    entityType: 'shipment',
    entityId: result.shipment.id,
    data: {
      tracking_number: result.shipment.tracking_number,
      total_price: Number(result.shipment.total_price),
      distance_km: Number(result.shipment.distance_km),
      duration_minutes: Number(result.shipment.duration_minutes),
      distance_source: result.shipment.distance_source,
      payment_required: result.payment_required,
    },
  });

  return created({
    ...result.shipment,
    payment_required: result.payment_required,
  });
});
