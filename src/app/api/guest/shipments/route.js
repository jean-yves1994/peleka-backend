const crypto = require('crypto');
const { withTransaction } = require('@/lib/db');
const { readJson, rateLimit, getClientIp } = require('@/lib/middleware');
const { createShipmentSchema } = require('@/lib/validation');
const { quoteShipment } = require('@/lib/pricing');
const { created } = require('@/lib/response');
const { BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { hashToken } = require('@/lib/jwt');

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request) => {
  rateLimit(`guest-shipment:${getClientIp(request) || 'unknown'}`, { max: 10, windowMs: 60_000 });
  const body = await readJson(request);
  const guestName = String(body?.guest_name || '').trim();
  const guestPhone = String(body?.guest_phone || '').trim();
  const guestEmail = body?.guest_email ? String(body.guest_email).trim().toLowerCase() : null;
  if (!guestName || !guestPhone) throw new BadRequestError('Guest name and phone are required');

  const shipmentBody = createShipmentSchema.parse(body);
  const quote = await quoteShipment({
    pickup_lat: shipmentBody.pickup_lat,
    pickup_lng: shipmentBody.pickup_lng,
    delivery_lat: shipmentBody.delivery_lat,
    delivery_lng: shipmentBody.delivery_lng,
    pickup_city: shipmentBody.pickup_city,
    delivery_city: shipmentBody.delivery_city,
    discount_code: shipmentBody.discount_code,
  });

  const rawAccessToken = crypto.randomBytes(32).toString('hex');

  const shipment = await withTransaction(async (client) => {
    const { rows: [s] } = await client.query(
      `INSERT INTO shipments (
        customer_id, is_guest, guest_name, guest_phone, guest_email, status,
        sender_name, sender_phone, recipient_name, recipient_phone,
        pickup_address, pickup_city, pickup_lat, pickup_lng, pickup_notes, pickup_scheduled_at,
        delivery_address, delivery_city, delivery_lat, delivery_lng, delivery_notes, delivery_scheduled_at,
        requires_signature, parcel_description, parcel_category, parcel_weight_kg,
        parcel_length_cm, parcel_width_cm, parcel_height_cm, parcel_declared_value, is_fragile,
        pricing_config_id, distance_km, duration_minutes, base_fare, distance_fee, weight_fee, time_fee,
        surge_multiplier, discount_amount, discount_code, tax_amount, subtotal, total_price, currency,
        rider_earnings, moto_earnings, platform_earnings, rider_commission_percentage, moto_commission_percentage
      ) VALUES (
        NULL, TRUE, $1, $2, $3, 'pending_payment',
        $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
        FALSE, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34,
        $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46
      ) RETURNING *`,
      [
        guestName, guestPhone, guestEmail,
        shipmentBody.sender_name, shipmentBody.sender_phone,
        shipmentBody.recipient_name, shipmentBody.recipient_phone,
        shipmentBody.pickup_address, shipmentBody.pickup_city || null,
        shipmentBody.pickup_lat, shipmentBody.pickup_lng, shipmentBody.pickup_notes || null, shipmentBody.pickup_scheduled_at || null,
        shipmentBody.delivery_address, shipmentBody.delivery_city || null,
        shipmentBody.delivery_lat, shipmentBody.delivery_lng, shipmentBody.delivery_notes || null, shipmentBody.delivery_scheduled_at || null,
        shipmentBody.parcel_description, shipmentBody.parcel_category || null, shipmentBody.parcel_weight_kg,
        shipmentBody.parcel_length_cm || null, shipmentBody.parcel_width_cm || null, shipmentBody.parcel_height_cm || null,
        shipmentBody.parcel_declared_value || null, shipmentBody.is_fragile,
        quote.pricing_config_id, quote.distance_km, quote.duration_minutes,
        quote.base_fare, quote.distance_fee, quote.weight_fee, quote.time_fee, quote.surge_multiplier,
        quote.discount_amount, quote.discount_code, quote.tax_amount, quote.subtotal, quote.total_price, quote.currency,
        quote.rider_earnings, quote.moto_earnings, quote.platform_earnings,
        quote.rider_commission_percentage, quote.moto_commission_percentage
      ]
    );

    await client.query(
      'INSERT INTO guest_shipment_access (shipment_id, token_hash) VALUES ($1,$2)',
      [s.id, hashToken(rawAccessToken)]
    );
    await client.query(
      `INSERT INTO shipment_status_history (shipment_id, from_status, to_status, changed_by, note)
       VALUES ($1, NULL, 'pending_payment', NULL, 'Guest shipment created, awaiting payment')`,
      [s.id]
    );
    return s;
  });

  await logAudit({
    request,
    action: 'shipment.guest_created',
    entityType: 'shipment',
    entityId: shipment.id,
    data: { tracking_number: shipment.tracking_number, total_price: shipment.total_price }
  });

  return created({
    ...shipment,
    payment_required: true,
    guest_access_token: rawAccessToken,
    quote
  });
});