const { withTransaction, query } = require("@/lib/db");
const { readJson, parseListParams } = require("@/lib/middleware");
const { requireAuth } = require("@/lib/auth");
const { createShipmentSchema } = require("@/lib/validation");
const { quoteShipment } = require("@/lib/pricing");
const { created, paginated } = require("@/lib/response");
const { ForbiddenError } = require("@/lib/errors");
const { withHandler } = require("@/lib/route-helpers");
const { logAudit } = require("@/lib/audit");
const { notify } = require("@/lib/notifications");

exports.dynamic = "force-dynamic";

/**
 * POST /api/shipments
 *
 * PAY-BEFORE: shipments are created as `pending_payment`. No rider can be
 * assigned until the Flutterwave webhook confirms payment and flips the
 * status to `awaiting_assignment`.
 */
exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  if (user.role !== "customer" && user.role !== "admin") {
    throw new ForbiddenError("Only customers or admins can create shipments");
  }
  const body = createShipmentSchema.parse(await readJson(request));
  const quote = await quoteShipment({
    pickup_lat: body.pickup_lat,
    pickup_lng: body.pickup_lng,
    delivery_lat: body.delivery_lat,
    delivery_lng: body.delivery_lng,
    parcel_weight_kg: body.parcel_weight_kg,
    pickup_city: body.pickup_city,
    delivery_city: body.delivery_city,
    discount_code: body.discount_code,
  });
  const customer_id = user.role === "admin" ? body.customer_id || user.id : user.id;

  const shipment = await withTransaction(async (client) => {
    const { rows: [s] } = await client.query(
      `INSERT INTO shipments (
         customer_id, status,
         sender_name, sender_phone, sender_email,
         recipient_name, recipient_phone, recipient_email,
         pickup_address, pickup_city, pickup_lat, pickup_lng, pickup_notes, pickup_scheduled_at,
         delivery_address, delivery_city, delivery_lat, delivery_lng, delivery_notes, delivery_scheduled_at,
         requires_signature,
         parcel_description, parcel_category, parcel_weight_kg,
         parcel_length_cm, parcel_width_cm, parcel_height_cm,
         parcel_declared_value, is_fragile,
         pricing_config_id, distance_km, duration_minutes,
         base_fare, distance_fee, weight_fee, time_fee,
         surge_multiplier, discount_amount, discount_code,
         tax_amount, subtotal, total_price, currency, rider_earnings
       ) VALUES (
         $1,'pending_payment', $2,$3,$4, $5,$6,$7,
         $8,$9,$10,$11,$12,$13, $14,$15,$16,$17,$18,$19, $20,
         $21,$22,$23, $24,$25,$26, $27,$28,
         $29,$30,$31, $32,$33,$34,$35, $36,$37,$38, $39,$40,$41,$42,$43
       ) RETURNING *`,
      [
        customer_id,
        body.sender_name, body.sender_phone, body.sender_email || null,
        body.recipient_name, body.recipient_phone, body.recipient_email || null,
        body.pickup_address, body.pickup_city || null, body.pickup_lat, body.pickup_lng,
        body.pickup_notes || null, body.pickup_scheduled_at || null,
        body.delivery_address, body.delivery_city || null, body.delivery_lat, body.delivery_lng,
        body.delivery_notes || null, body.delivery_scheduled_at || null,
        !!body.requires_signature,
        body.parcel_description, body.parcel_category || null, body.parcel_weight_kg,
        body.parcel_length_cm || null, body.parcel_width_cm || null, body.parcel_height_cm || null,
        body.parcel_declared_value || null, !!body.is_fragile,
        quote.pricing_config_id, quote.distance_km, quote.duration_minutes,
        quote.base_fare, quote.distance_fee, quote.weight_fee, quote.time_fee,
        quote.surge_multiplier, quote.discount_amount, quote.discount_code,
        quote.tax_amount, quote.subtotal, quote.total_price, quote.currency, quote.rider_earnings,
      ],
    );
    await client.query(
      `INSERT INTO shipment_status_history (shipment_id, from_status, to_status, changed_by, note)
       VALUES ($1, NULL, 'pending_payment', $2, 'Shipment created — awaiting payment')`,
      [s.id, user.id],
    );
    // Discount used_count is incremented in the Flutterwave webhook (after
    // money actually arrives) so abandoned checkouts don't burn promo uses.
    return s;
  });

  await logAudit({
    request, actor: user, action: "shipment.created",
    entityType: "shipment", entityId: shipment.id,
    data: {
      tracking_number: shipment.tracking_number,
      total_price: shipment.total_price,
      currency: shipment.currency,
      status: "pending_payment",
    },
  });

  // Admins are NOT notified yet — an unpaid shipment isn't actionable.
  // The webhook notifies them once payment is confirmed.
  try {
    await notify({
      userId: customer_id,
      title: "Complete your payment",
      body: `Shipment ${shipment.tracking_number} is reserved. Pay to get a rider assigned.`,
      data: { type: "shipment.pending_payment", shipment_id: shipment.id },
    });
  } catch (_) {}

  return created({ shipment, quote });
});

exports.GET = withHandler(async (request) => {
  const user = await requireAuth(request);
  const { page, pageSize, offset, sortCol, sortDir } = parseListParams(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");

  const filters = [];
  const params = [];
  if (user.role === "customer") {
    params.push(user.id);
    filters.push(`customer_id=$${params.length}`);
  } else if (user.role === "rider") {
    params.push(user.id);
    filters.push(`rider_id=$${params.length}`);
    filters.push(`status <> 'pending_payment'`); // riders never see unpaid work
  }
  if (status) {
    params.push(status);
    filters.push(`status=$${params.length}`);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const allowedSort = new Set(["created_at","updated_at","status","total_price","distance_km"]);
  const orderBy = allowedSort.has(sortCol) ? sortCol : "created_at";

  const { rows } = await query(
    `SELECT * FROM shipments ${where} ORDER BY ${orderBy} ${sortDir} LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM shipments ${where}`, params,
  );
  return paginated(rows, { page, pageSize, total: count });
});
