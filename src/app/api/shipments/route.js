/**
 * GET  /api/shipments — list (customer sees own, staff see all)
 * POST /api/shipments — create
 *
 * ⚠️ THIS IS A REFERENCE IMPLEMENTATION, NOT A DROP-IN REPLACEMENT.
 *
 * I don't have your existing file, so I can't preserve whatever else is in it.
 * Read RECONCILE.md before overwriting — it lists the six things to check
 * against your version (helper names, response envelope, column names,
 * validation, tracking-number format, notification hooks).
 *
 * WHAT'S NEW HERE, AND WHY
 *
 *  1. REAL DISTANCE. Your test shipment recorded distance_km 0.00 from
 *     identical pickup/delivery coordinates. Under the old per-km formula that
 *     hid itself; under band pricing every trip would cost 2 000 RWF no matter
 *     how far. Distance is now computed via OSRM with a haversine fallback, and
 *     identical points are rejected.
 *
 *  2. BAND PRICING. 0-10 km → 2 000, 10-15 → 3 000, 15-20 → 5 000.
 *
 *  3. PREMIER CUSTOMERS. Their shipments skip payment and dispatch straight to
 *     awaiting_assignment, to be invoiced later. A credit limit is enforced at
 *     creation — that's the only thing bounding an unpaid balance, since these
 *     shipments move before any money does.
 *
 *  4. KNOWN LOCATION IDS from the new picker, so you can report on popular
 *     routes and so correcting a coordinate later doesn't rewrite history.
 */
const { withTransaction, query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { ok, created } = require('@/lib/response');
const { BadRequestError, ForbiddenError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { quote } = require('@/lib/pricing-bands');
const { roadDistance } = require('@/lib/distance');

exports.dynamic = 'force-dynamic';

// ── Validation helpers ──────────────────────────────────────────────────────

/**
 * Rwandan mobile numbers: 07XXXXXXXX, or +250 / 250 prefixed.
 * Normalised to the local 10-digit form, because that's what Paypack expects
 * and what riders read off the screen.
 */
function normalizePhone(raw, label) {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  const m = /^(?:\+?250|0)?(7[2389]\d{7})$/.exec(digits.replace(/^\+/, ''));
  if (!m) {
    throw new BadRequestError(
      `${label} doesn't look like a Rwandan mobile number. `
      + 'Use the format 07XXXXXXXX.',
    );
  }
  return `0${m[1]}`;
}

function requireText(value, label, { max = 200 } = {}) {
  const s = String(value ?? '').trim();
  if (!s) throw new BadRequestError(`${label} is required.`);
  if (s.length > max) throw new BadRequestError(`${label} is too long.`);
  return s;
}

function coord(body, latKey, lngKey, label) {
  const lat = Number(body?.[latKey]);
  const lng = Number(body?.[lngKey]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
    throw new BadRequestError(
      `Please choose a ${label} location using the search or the map.`,
    );
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new BadRequestError(`The ${label} coordinates are not valid.`);
  }
  return { lat, lng };
}

/** PLK-YYMMDD-XXXXXX. Replace if your existing format differs. */
function trackingNumber() {
  const d = new Date();
  const ymd = [
    String(d.getFullYear()).slice(2),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PLK-${ymd}-${rand}`;
}

// ── GET ─────────────────────────────────────────────────────────────────────

exports.GET = withHandler(async (request) => {
  const user = await requireAuth(request);
  const url = new URL(request.url);

  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || 20)));
  const offset = (page - 1) * pageSize;

  const isStaff = user.role === 'admin' || user.role === 'dispatcher';
  const args = [];
  const where = [];

  if (user.role === 'customer') {
    args.push(user.id);
    where.push(`s.customer_id = $${args.length}`);
  } else if (user.role === 'rider') {
    args.push(user.id);
    where.push(`s.rider_id = $${args.length}`);
  } else if (isStaff) {
    const cid = url.searchParams.get('customer_id');
    if (cid) { args.push(cid); where.push(`s.customer_id = $${args.length}`); }
  }

  const status = url.searchParams.get('status');
  if (status) {
    const list = status.split(',').map((x) => x.trim()).filter(Boolean);
    args.push(list);
    where.push(`s.status = ANY($${args.length})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM shipments s ${whereSql}`, args,
  );

  args.push(pageSize, offset);
  const { rows } = await query(
    `SELECT s.*
       FROM shipments s
       ${whereSql}
      ORDER BY s.created_at DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  );

  const total = countRows[0].total;
  return ok(rows, { page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
});

// ── POST ────────────────────────────────────────────────────────────────────

exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  if (user.role !== 'customer') {
    throw new ForbiddenError('Only customers can create shipments.');
  }

  const body = await readJson(request);

  // ── 1 · Validate input ────────────────────────────────────────────────────
  const senderName = requireText(body?.sender_name, 'Sender name', { max: 120 });
  const senderPhone = normalizePhone(body?.sender_phone, 'Sender phone');
  const recipientName = requireText(body?.recipient_name, 'Recipient name', { max: 120 });
  const recipientPhone = normalizePhone(body?.recipient_phone, 'Recipient phone');

  const pickupAddress = requireText(body?.pickup_address, 'Pickup address');
  const deliveryAddress = requireText(body?.delivery_address, 'Delivery address');

  const pickup = coord(body, 'pickup_lat', 'pickup_lng', 'pickup');
  const delivery = coord(body, 'delivery_lat', 'delivery_lng', 'delivery');

  const parcelDescription = requireText(body?.parcel_description, 'Parcel description', { max: 500 });
  const parcelCategory = String(body?.parcel_category ?? 'other').trim();
  const parcelWeight = Number(body?.parcel_weight_kg ?? 1);
  if (!Number.isFinite(parcelWeight) || parcelWeight <= 0 || parcelWeight > 100) {
    throw new BadRequestError('Parcel weight must be between 0 and 100 kg.');
  }

  // ── 2 · Distance ──────────────────────────────────────────────────────────
  // Identical coordinates almost always means a typed address with nothing
  // geocoded behind it. Under band pricing that silently charges the minimum
  // fare for a cross-city delivery, so reject it rather than absorb the loss.
  if (pickup.lat === delivery.lat && pickup.lng === delivery.lng) {
    throw new BadRequestError(
      'Pickup and delivery are the same place. Please choose a different '
      + 'delivery location.',
    );
  }

  const { km: distanceKm, minutes: durationMinutes, source: distanceSource } =
    await roadDistance(pickup.lat, pickup.lng, delivery.lat, delivery.lng);

  // ── 3 · Discount ──────────────────────────────────────────────────────────
  // Validated properly here (unlike the quote endpoint, which is forgiving) —
  // an invalid code at creation time should be an explicit error, not a
  // silently-higher price.
  let discountAmount = 0;
  let discountCode = null;

  const rawCode = body?.discount_code ? String(body.discount_code).trim().toUpperCase() : null;
  if (rawCode) {
    const { rows } = await query(
      `SELECT * FROM discounts
        WHERE code = $1 AND is_active = TRUE
          AND (valid_from IS NULL OR valid_from <= NOW())
          AND (valid_until IS NULL OR valid_until >= NOW())
        LIMIT 1`,
      [rawCode],
    );
    const d = rows[0];
    if (!d) throw new BadRequestError('That promo code is not valid or has expired.');

    if (d.max_uses !== null && Number(d.used_count) >= Number(d.max_uses)) {
      throw new BadRequestError('That promo code has been fully used.');
    }

    if (d.discount_type === 'percentage') {
      const base = await quote(distanceKm, { discountAmount: 0 });
      discountAmount = Math.round(Number(base.total_price) * (Number(d.discount_value) / 100));
      if (d.max_discount_amount) {
        discountAmount = Math.min(discountAmount, Number(d.max_discount_amount));
      }
    } else {
      discountAmount = Number(d.discount_value);
    }
    discountCode = d.code;
  }

  // ── 4 · Price ─────────────────────────────────────────────────────────────
  const surge = Number(body?.surge_multiplier ?? 1) || 1;

  const pricing = await quote(distanceKm, {
    surgeMultiplier: surge,
    discountAmount,
  });

  if (!pricing) {
    // Band pricing is off. Rather than silently falling back to a formula that
    // produces 119.18 RWF fares, say so — a misconfigured price is worse than
    // a clear error.
    throw new BadRequestError(
      'Pricing is not configured. Please contact Peleka support.',
    );
  }

  // ── 5 · Premier terms ─────────────────────────────────────────────────────
  const { rows: custRows } = await query(
    `SELECT is_premier, premier_credit_limit, full_name FROM users WHERE id = $1`,
    [user.id],
  );
  const customer = custRows[0];
  const isPremier = customer?.is_premier === true;

  if (isPremier && customer.premier_credit_limit !== null) {
    const { rows: owedRows } = await query(
      `SELECT COALESCE(SUM(total_price), 0) AS owed
         FROM shipments
        WHERE customer_id = $1
          AND payment_terms = 'invoice'
          AND invoice_id IS NULL
          AND status <> 'cancelled'`,
      [user.id],
    );
    const owed = Number(owedRows[0].owed);
    if (owed + Number(pricing.total_price) > Number(customer.premier_credit_limit)) {
      throw new BadRequestError(
        'This shipment would exceed your account credit limit. Please settle '
        + 'your outstanding invoice, or contact Peleka support.',
      );
    }
  }

  const paymentTerms = isPremier ? 'invoice' : 'prepaid';
  const initialStatus = isPremier ? 'awaiting_assignment' : 'pending_payment';

  // ── 6 · Insert ────────────────────────────────────────────────────────────
  const shipment = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO shipments (
         tracking_number, customer_id, status,
         sender_name, sender_phone, sender_email,
         recipient_name, recipient_phone, recipient_email,
         pickup_address, pickup_city, pickup_lat, pickup_lng,
         pickup_notes, pickup_location_id,
         delivery_address, delivery_city, delivery_lat, delivery_lng,
         delivery_notes, delivery_location_id,
         parcel_description, parcel_category, parcel_weight_kg,
         is_fragile, requires_signature, declared_value,
         distance_km, duration_minutes,
         pricing_config_id, pricing_band_id,
         base_fare, distance_fee, weight_fee, time_fee,
         surge_multiplier, discount_amount, discount_code,
         subtotal, tax_amount, total_price, currency, rider_earnings,
         payment_terms
       ) VALUES (
         $1,$2,$3,
         $4,$5,$6,
         $7,$8,$9,
         $10,$11,$12,$13,
         $14,$15,
         $16,$17,$18,$19,
         $20,$21,
         $22,$23,$24,
         $25,$26,$27,
         $28,$29,
         $30,$31,
         $32,$33,$34,$35,
         $36,$37,$38,
         $39,$40,$41,$42,$43,
         $44
       ) RETURNING *`,
      [
        trackingNumber(), user.id, initialStatus,
        senderName, senderPhone, body?.sender_email ?? null,
        recipientName, recipientPhone, body?.recipient_email ?? null,
        pickupAddress, body?.pickup_city ?? 'Kigali', pickup.lat, pickup.lng,
        body?.pickup_notes ?? null, body?.pickup_location_id ?? null,
        deliveryAddress, body?.delivery_city ?? 'Kigali', delivery.lat, delivery.lng,
        body?.delivery_notes ?? null, body?.delivery_location_id ?? null,
        parcelDescription, parcelCategory, parcelWeight,
        body?.is_fragile === true, body?.requires_signature === true,
        body?.declared_value ?? null,
        pricing.distance_km, durationMinutes,
        pricing.pricing_config_id, pricing.pricing_band_id,
        pricing.base_fare, pricing.distance_fee, pricing.weight_fee, pricing.time_fee,
        pricing.surge_multiplier, pricing.discount_amount, discountCode,
        pricing.subtotal, pricing.tax_amount, pricing.total_price,
        pricing.currency, pricing.rider_earnings,
        paymentTerms,
      ],
    );
    const s = rows[0];

    await client.query(
      `INSERT INTO shipment_status_history
         (shipment_id, from_status, to_status, changed_by, note)
       VALUES ($1, NULL, $2, $3, $4)`,
      [s.id, initialStatus, user.id,
       isPremier
         ? 'Shipment created — premier account, dispatching on invoice terms'
         : 'Shipment created, awaiting payment'],
    );

    return s;
  });

  await logAudit({
    request, actor: user, action: 'shipment.created',
    entityType: 'shipment', entityId: shipment.id,
    metadata: {
      tracking_number: shipment.tracking_number,
      distance_km: pricing.distance_km,
      distance_source: distanceSource,
      band: pricing.band_label,
      total: pricing.total_price,
      payment_terms: paymentTerms,
    },
  });

  // The app branches on payment_required to decide whether to show the payment
  // screen or go straight to tracking. Without it, premier customers would be
  // sent to a payment flow that has nothing to charge.
  return created({
    ...shipment,
    payment_required: !isPremier,
    payment_terms: paymentTerms,
    band_label: pricing.band_label,
    distance_source: distanceSource,
  });
});
