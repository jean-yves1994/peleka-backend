/**
 * POST /api/shipments/quote — price preview, no shipment created.
 *
 * WHY THIS EXISTS
 * Under band pricing, the fare is a big round number that jumps at 10 km and
 * 15 km. A customer who picks a delivery point 200 m past a band edge and only
 * discovers the 1 000 RWF jump after committing will feel misled. Showing the
 * fare live, as soon as both points are set, removes that entirely.
 *
 * It also lets the app tell a premier customer up front that this order will be
 * invoiced rather than charged now.
 *
 * Body:
 *   {
 *     "pickup_lat": -1.9536,  "pickup_lng": 30.0606,
 *     "delivery_lat": -1.9375,"delivery_lng": 30.1234,
 *     "discount_code": "LAUNCH500"        // optional
 *   }
 *
 * Deliberately cheap: no writes, no shipment row, safe to call on every pin
 * adjustment.
 */
const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { quote } = require('@/lib/pricing-bands');
const { roadDistance } = require('@/lib/distance');

exports.dynamic = 'force-dynamic';

/** Validate a coordinate pair, throwing customer-readable errors. */
function coord(body, latKey, lngKey, label) {
  const lat = Number(body?.[latKey]);
  const lng = Number(body?.[lngKey]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
    throw new BadRequestError(`Please choose a ${label} location on the map.`);
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new BadRequestError(`The ${label} coordinates are not valid.`);
  }
  return { lat, lng };
}

/**
 * Look up a discount code and return the amount it takes off, or 0.
 * Silently ignores invalid codes here — the quote shouldn't error out over a
 * typo'd promo. Creation validates properly.
 */
async function discountAmountFor(code, customerId) {
  if (!code) return { amount: 0, applied: false, reason: null };

  const { rows } = await query(
    `SELECT * FROM discounts
      WHERE code = $1
        AND is_active = TRUE
        AND (valid_from IS NULL OR valid_from <= NOW())
        AND (valid_until IS NULL OR valid_until >= NOW())
      LIMIT 1`,
    [String(code).trim().toUpperCase()],
  );
  const d = rows[0];
  if (!d) return { amount: 0, applied: false, reason: 'Code not found or expired' };

  if (d.max_uses !== null && Number(d.used_count) >= Number(d.max_uses)) {
    return { amount: 0, applied: false, reason: 'This code has been fully used' };
  }

  // Per-customer cap, if your schema has one.
  if (d.max_uses_per_customer !== null && d.max_uses_per_customer !== undefined) {
    const { rows: usedRows } = await query(
      `SELECT COUNT(*)::int AS n FROM shipments
        WHERE customer_id = $1 AND discount_code = $2 AND status <> 'cancelled'`,
      [customerId, d.code],
    );
    if (usedRows[0].n >= Number(d.max_uses_per_customer)) {
      return { amount: 0, applied: false, reason: 'You have already used this code' };
    }
  }

  return { discount: d, applied: true, reason: null };
}

exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  const body = await readJson(request);

  const pickup = coord(body, 'pickup_lat', 'pickup_lng', 'pickup');
  const delivery = coord(body, 'delivery_lat', 'delivery_lng', 'delivery');

  // Identical points almost always means the client sent a typed address with
  // no geocoding behind it. Under band pricing that would quietly charge the
  // minimum fare for a cross-city delivery.
  if (pickup.lat === delivery.lat && pickup.lng === delivery.lng) {
    throw new BadRequestError(
      'Pickup and delivery are the same place. Please choose a different '
      + 'delivery location.',
    );
  }

  const { km, minutes, source } = await roadDistance(
    pickup.lat, pickup.lng, delivery.lat, delivery.lng,
  );

  // Resolve the discount first — band pricing applies it to the tax-inclusive
  // total, so it has to be known before the fare is computed.
  const promo = await discountAmountFor(body?.discount_code, user.id);

  let discountAmount = 0;
  if (promo.applied && promo.discount) {
    const d = promo.discount;
    // Percentage codes need the undiscounted fare first.
    if (d.discount_type === 'percentage') {
      const base = await quote(km, { surgeMultiplier: 1, discountAmount: 0 });
      if (base) {
        discountAmount = Math.round(
          Number(base.total_price) * (Number(d.discount_value) / 100),
        );
        if (d.max_discount_amount) {
          discountAmount = Math.min(discountAmount, Number(d.max_discount_amount));
        }
      }
    } else {
      discountAmount = Number(d.discount_value);
    }
  }

  const pricing = await quote(km, { surgeMultiplier: 1, discountAmount });
  if (!pricing) {
    throw new BadRequestError(
      'Distance-band pricing is not enabled. Run migration 0009 and set '
      + 'pricing_configs.use_distance_bands = TRUE.',
    );
  }

  // Tell the app whether this customer pays now or gets invoiced, so it can
  // label the button correctly before anything is created.
  const { rows: custRows } = await query(
    `SELECT is_premier, premier_credit_limit FROM users WHERE id = $1`,
    [user.id],
  );
  const isPremier = custRows[0]?.is_premier === true;

  return ok({
    distance_km: Number(km.toFixed(2)),
    duration_minutes: minutes,
    // 'estimate' means OSRM was unreachable and this is straight-line × 1.3.
    // Worth surfacing so you can spot it in logs if fares look off.
    distance_source: source,

    band_label: pricing.band_label,
    subtotal: pricing.subtotal,
    tax_amount: pricing.tax_amount,
    discount_amount: pricing.discount_amount,
    total_price: pricing.total_price,
    currency: pricing.currency,

    discount: {
      applied: promo.applied,
      code: promo.applied ? promo.discount.code : null,
      reason: promo.reason,
    },

    payment_required: !isPremier,
    payment_terms: isPremier ? 'invoice' : 'prepaid',
  });
});
