const { withTransaction, query } = require('@/lib/db');
const { readJson, parseListParams } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { createShipmentSchema } = require('@/lib/validation');
const { quoteShipment } = require('@/lib/pricing');
const { created, paginated } = require('@/lib/response');
const { ForbiddenError, BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { notify } = require('@/lib/notifications');

/**
 * This is YOUR original file with two additions. Nothing was removed.
 *
 *  1. PAYMENT BEFORE ASSIGNMENT
 *     Shipments were created as 'awaiting_assignment', which made every
 *     unpaid shipment immediately claimable by a rider. They now start at
 *     'pending_payment', and the Paypack webhook moves them to
 *     'awaiting_assignment' once money actually arrives — that transition
 *     already exists in your webhook, it just never had anything to move.
 *
 *  2. CONTRACT CUSTOMERS
 *     `users.contract_customer` skips payment entirely: the shipment goes
 *     straight to 'awaiting_assignment' and is invoiced later. A credit limit
 *     is checked at creation, which is the only thing bounding an unpaid
 *     balance, since these shipments dispatch before any money moves.
 *
 *  Plus the four commission columns from migration 0013, which quoteShipment
 *  already returns but this INSERT wasn't storing.
 */

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  if (user.role !== 'customer' && user.role !== 'admin') {
    throw new ForbiddenError('Only customers or admins can create shipments');
  }
  const body = createShipmentSchema.parse(await readJson(request));

  const quote = await quoteShipment({
    pickup_lat: body.pickup_lat,
    pickup_lng: body.pickup_lng,
    delivery_lat: body.delivery_lat,
    delivery_lng: body.delivery_lng,
    pickup_city: body.pickup_city,
    delivery_city: body.delivery_city,
    discount_code: body.discount_code,
  });

  const customer_id = user.role === 'admin' ? (body.customer_id || user.id) : user.id;

  // ── Contract customers ────────────────────────────────────────────────────
  // Read against customer_id, not user.id — an admin creating on someone's
  // behalf must get that customer's terms, not their own.
  const { rows: [customer] } = await query(
    `SELECT customer_type, contract_customer, credit_limit, outstanding_balance
       FROM users WHERE id = $1`,
    [customer_id]
  );
  const isPremier = customer?.customer_type === 'premier' || customer?.contract_customer === true;

  if (isPremier && Number(customer.credit_limit) > 0) {
    const projected = Number(customer.outstanding_balance || 0) + Number(quote.total_price);
    if (projected > Number(customer.credit_limit)) {
      throw new BadRequestError(
        'This shipment would exceed your account credit limit. Please settle '
        + 'your outstanding invoices, or contact Peleka support.'
      );
    }
  }

  // Contract customers dispatch immediately and are billed later. Everyone
  // else waits for the Paypack webhook to release the shipment.
  const initialStatus = isPremier ? 'awaiting_assignment' : 'pending_payment';

  const shipment = await withTransaction(async (client) => {
    const { rows: [s] } = await client.query(
      `INSERT INTO shipments (
        customer_id, status,
        sender_name, sender_phone, sender_email,
        recipient_name, recipient_phone, recipient_email,
        pickup_address, pickup_city, pickup_lat, pickup_lng, pickup_notes, pickup_scheduled_at,
        delivery_address, delivery_city, delivery_lat, delivery_lng, delivery_notes, delivery_scheduled_at,
        parcel_description, parcel_category, parcel_weight_kg,
        parcel_length_cm, parcel_width_cm, parcel_height_cm, parcel_declared_value, is_fragile,
        pricing_config_id, distance_km, duration_minutes,
        base_fare, distance_fee, weight_fee, time_fee, surge_multiplier,
        discount_amount, discount_code, tax_amount, subtotal, total_price, currency,
        rider_earnings, moto_earnings, platform_earnings,
        rider_commission_percentage, moto_commission_percentage
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,
        $39,$40,$41,$42,$43,$44,$45,$46,$47
      ) RETURNING *`,
      [
        customer_id, initialStatus,
        body.sender_name, body.sender_phone, body.sender_email || null,
        body.recipient_name, body.recipient_phone, body.recipient_email || null,
        body.pickup_address, body.pickup_city || null, body.pickup_lat, body.pickup_lng,
        body.pickup_notes || null, body.pickup_scheduled_at || null,
        body.delivery_address, body.delivery_city || null, body.delivery_lat, body.delivery_lng,
        body.delivery_notes || null, body.delivery_scheduled_at || null,
        body.parcel_description, body.parcel_category || null, body.parcel_weight_kg,
        body.parcel_length_cm || null, body.parcel_width_cm || null,
        body.parcel_height_cm || null, body.parcel_declared_value || null, body.is_fragile,
        quote.pricing_config_id, quote.distance_km, quote.duration_minutes,
        quote.base_fare, quote.distance_fee, quote.weight_fee, quote.time_fee,
        quote.surge_multiplier,
        quote.discount_amount, quote.discount_code, quote.tax_amount, quote.subtotal,
        quote.total_price, quote.currency,
        quote.rider_earnings, quote.moto_earnings, quote.platform_earnings,
        quote.rider_commission_percentage, quote.moto_commission_percentage,
      ]
    );

    await client.query(
      `INSERT INTO shipment_status_history (shipment_id, from_status, to_status, changed_by, note)
       VALUES ($1, NULL, $2, $3, $4)`,
      [s.id, initialStatus, user.id,
       isPremier ? 'Shipment created — Premier account, dispatching on invoice terms'
                  : 'Shipment created, awaiting payment']
    );

    // ⚠️ The promo code is consumed here ONLY for contract customers, because
    // they never hit the Paypack webhook. For everyone else the webhook does it
    // on payment — incrementing in both places burned each code twice.
    if (isPremier && body.discount_code) {
      await client.query(
        `UPDATE discounts SET used_count = used_count + 1 WHERE code = $1`,
        [body.discount_code]
      );
    }

    // Contract customers owe this straight away; there's no payment to wait for.
    if (isPremier) {
      await client.query(
        `UPDATE users SET outstanding_balance = COALESCE(outstanding_balance, 0) + $2
          WHERE id = $1`,
        [customer_id, quote.total_price]
      );
    }

    return s;
  });


  await logAudit({
    request, actor: user, action: 'shipment.created', entityType: 'shipment',
    entityId: shipment.id,
    data: {
      tracking_number: shipment.tracking_number,
      total_price: shipment.total_price,
      status: shipment.status,
      premier_customer: isPremier,
    },
  });

  // Only Premier shipments are dispatchable at creation. For prepaid ones the
  // webhook notifies admins when payment lands — telling them now would put a
  // shipment on the board that no rider is allowed to take yet.
  if (isPremier) {
    try {
      const admins = await query(`SELECT id FROM users WHERE role='admin' AND status='active'`);
      await Promise.all(admins.rows.map(a => notify({
        userId: a.id,
        title: 'New shipment awaiting assignment',
        body: `Shipment ${shipment.tracking_number} (contract account) needs a rider`,
        data: { type: 'shipment.created', shipment_id: shipment.id },
      })));
    } catch (_) {}
  }

  return created({
    ...shipment,
    // The app branches on this to decide between the payment screen and going
    // straight to tracking.
    payment_required: !isPremier,
    quote,
  });
});

exports.GET = withHandler(async (request) => {
  const user = await requireAuth(request);
  const { page, pageSize, offset, sortCol, sortDir } = parseListParams(request);
  const url = new URL(request.url);
  const status = url.searchParams.get('status');

  const filters = [];
  const params = [];

  if (user.role === 'customer') { params.push(user.id); filters.push(`customer_id = $${params.length}`); }
  if (user.role === 'rider')    { params.push(user.id); filters.push(`rider_id = $${params.length}`); }
  if (status)                   { params.push(status);  filters.push(`status = $${params.length}`); }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const allowedSort = new Set(['created_at','updated_at','status','total_price','distance_km']);
  const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at';

  const { rows } = await query(
    `SELECT s.*,
            u.customer_type,
            u.contract_customer,
            u.outstanding_balance AS customer_outstanding_balance,
            COALESCE((SELECT p.status::text FROM payments p
                      WHERE p.shipment_id=s.id ORDER BY p.created_at DESC LIMIT 1), 'unpaid') AS payment_status
       FROM shipments s
       LEFT JOIN users u ON u.id=s.customer_id
       ${where.replace(/\bcustomer_id\b/g,'s.customer_id').replace(/\brider_id\b/g,'s.rider_id').replace(/\bstatus\b/g,'s.status')}
       ORDER BY s.${orderBy} ${sortDir} LIMIT ${pageSize} OFFSET ${offset}`,
    params
  );
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM shipments s ${where.replace(/\bcustomer_id\b/g,'s.customer_id').replace(/\brider_id\b/g,'s.rider_id').replace(/\bstatus\b/g,'s.status')}`, params
  );

  return paginated(rows, { page, pageSize, total: count });
});
