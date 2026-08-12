const { query } = require('./db');
const { NotFoundError, BadRequestError } = require('./errors');
const { getDistanceMatrix } = require('./distance');

async function getActivePricingConfig() {
  const { rows } = await query(`SELECT * FROM pricing_configs WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1`);
  if (!rows[0]) throw new NotFoundError('No active pricing configuration');
  return rows[0];
}
async function findRouteOverride(pickupCity, deliveryCity) {
  if (!pickupCity || !deliveryCity) return null;
  const { rows } = await query(
    `SELECT * FROM route_prices
      WHERE is_active = TRUE
        AND lower(origin_city) = lower($1)
        AND lower(destination_city) = lower($2) LIMIT 1`,
    [pickupCity, deliveryCity]
  );
  return rows[0] || null;
}
async function loadDiscount(code) {
  if (!code) return null;
  const { rows } = await query(`SELECT * FROM discounts WHERE code = $1 AND is_active = TRUE`, [code]);
  const d = rows[0];
  if (!d) throw new BadRequestError('Invalid discount code');
  const now = new Date();
  if (d.valid_from && new Date(d.valid_from) > now) throw new BadRequestError('Discount not yet valid');
  if (d.valid_to && new Date(d.valid_to) < now) throw new BadRequestError('Discount expired');
  if (d.max_uses && d.used_count >= d.max_uses) throw new BadRequestError('Discount usage limit reached');
  return d;
}
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function computeDiscount(subtotal, discount) {
  if (!discount) return 0;
  const raw = discount.discount_type === 'percent'
    ? subtotal * (Number(discount.amount) / 100)
    : Number(discount.amount);
  return Math.min(subtotal, Math.max(0, round2(raw)));
}

/**
 * Split the net fare three ways: rider, motorbike owner, Peleka.
 *
 * The base is `afterDiscount` — the PRE-TAX amount. VAT belongs to RRA and
 * isn't anyone's commission to share.
 *
 * Peleka takes the REMAINDER rather than its own rounded percentage. Three
 * independent roundings can otherwise miss the net by a franc, and payouts stop
 * reconciling against what was actually collected.
 *
 * Guarded so a bad config can't hand out more than came in: if the two
 * percentages exceed 100, the motorbike share is capped and Peleka lands at
 * zero rather than negative.
 */
function splitEarnings(afterDiscount, config) {
  const riderPct = Math.max(0, Number(config.rider_commission_percentage) || 0);
  const rawMotoPct = Math.max(0, Number(config.moto_commission_percentage) || 0);

  const motoPct = Math.min(rawMotoPct, Math.max(0, 100 - riderPct));

  const rider_earnings = round2(afterDiscount * (riderPct / 100));
  const moto_earnings = round2(afterDiscount * (motoPct / 100));
  const platform_earnings = round2(afterDiscount - rider_earnings - moto_earnings);

  return {
    rider_earnings,
    moto_earnings,
    platform_earnings,
    rider_commission_percentage: riderPct,
    moto_commission_percentage: motoPct,
  };
}

/**
 * Quote a shipment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DISTANCE-ONLY PRICING
 *
 *     fare = base_fare + (billable_km × price_per_km)
 *
 * Parcel weight no longer affects the price. `weight_fee` is always 0 and
 * `config.price_per_kg` is deliberately never read — leaving the read in would
 * let a stale value on an old config quietly reappear in a fare.
 *
 * `weight_fee` is still returned, and still written to the shipment, because
 * the column is NOT NULL and existing receipts and dashboards read it. It just
 * always reads 0.00.
 *
 * `parcel_weight_kg` is still accepted and stored — useful for the rider to
 * know what they're carrying — it simply doesn't enter the calculation.
 *
 * ⚠️ `time_fee` is also not distance. It survives here because your config has
 *    `price_per_minute DEFAULT 0.00`, so it contributes nothing unless someone
 *    sets it. Say the word and I'll strip it out entirely.
 */
async function quoteShipment(args) {
  const config = await getActivePricingConfig();
  const route = await findRouteOverride(args.pickup_city, args.delivery_city);
  const discount = await loadDiscount(args.discount_code);
  const dm = await getDistanceMatrix(
    { lat: args.pickup_lat, lng: args.pickup_lng },
    { lat: args.delivery_lat, lng: args.delivery_lng }
  );

  const currency = route?.currency || config.currency;
  let base_fare = 0, distance_fee = 0, time_fee = 0, subtotal = 0;

  // Weight never affects the fare. Held at 0 so the NOT NULL column and any
  // existing receipt layout still work.
  const weight_fee = 0;

  if (route) {
    subtotal = round2(Number(route.flat_price));
    base_fare = subtotal;
  } else {
    base_fare = round2(Number(config.base_fare));
    const billableKm = Math.max(0, dm.distance_km - Number(config.free_km || 0));
    distance_fee = round2(billableKm * Number(config.price_per_km));
    time_fee = round2(dm.duration_minutes * Number(config.price_per_minute || 0));

    let raw = base_fare + distance_fee + time_fee;
    raw *= Number(config.surge_multiplier || 1);
    if (raw < Number(config.min_price)) raw = Number(config.min_price);
    if (config.max_price && raw > Number(config.max_price)) raw = Number(config.max_price);
    subtotal = round2(raw);
  }

  const discount_amount = computeDiscount(subtotal, discount);
  const afterDiscount = round2(subtotal - discount_amount);
  const tax_amount = round2(afterDiscount * (Number(config.tax_percentage) / 100));
  const total_price = round2(afterDiscount + tax_amount);

  const earnings = splitEarnings(afterDiscount, config);

  return {
    currency, pricing_config_id: config.id,
    distance_km: dm.distance_km, duration_minutes: dm.duration_minutes, distance_source: dm.source,
    surge_multiplier: Number(config.surge_multiplier),
    base_fare, distance_fee, weight_fee, time_fee, subtotal,
    discount_code: discount?.code || null, discount_amount,
    tax_amount, total_price,

    rider_earnings: earnings.rider_earnings,
    moto_earnings: earnings.moto_earnings,
    platform_earnings: earnings.platform_earnings,

    // The rates actually applied, so the caller can freeze them onto the
    // shipment. Changing the config later must not rewrite what a rider or a
    // bike owner was already owed.
    rider_commission_percentage: earnings.rider_commission_percentage,
    moto_commission_percentage: earnings.moto_commission_percentage,

    breakdown_note: route ? 'Flat route pricing applied' : 'Distance-based pricing',
  };
}
module.exports = { quoteShipment, getActivePricingConfig, loadDiscount, splitEarnings };
