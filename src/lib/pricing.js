const { query } = require("./db");
const { NotFoundError, BadRequestError } = require("./errors");
const { roadDistance, haversine } = require("./distance");

async function getActivePricingConfig() {
  const { rows } = await query(
    `SELECT * FROM pricing_configs WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1`,
  );
  if (!rows[0]) throw new NotFoundError("No active pricing configuration");
  return rows[0];
}

async function findRouteOverride(pickupCity, deliveryCity) {
  if (!pickupCity || !deliveryCity) return null;
  const { rows } = await query(
    `SELECT * FROM route_prices
      WHERE is_active = TRUE
        AND lower(origin_city) = lower($1)
        AND lower(destination_city) = lower($2) LIMIT 1`,
    [pickupCity, deliveryCity],
  );
  return rows[0] || null;
}

async function loadDiscount(code) {
  if (!code) return null;
  const { rows } = await query(
    `SELECT * FROM discounts WHERE code = $1 AND is_active = TRUE`,
    [code],
  );
  const d = rows[0];
  if (!d) throw new BadRequestError("Invalid discount code");
  const now = new Date();
  if (d.valid_from && new Date(d.valid_from) > now) throw new BadRequestError("Discount not yet valid");
  if (d.valid_to && new Date(d.valid_to) < now) throw new BadRequestError("Discount expired");
  if (d.max_uses && d.used_count >= d.max_uses) throw new BadRequestError("Discount usage limit reached");
  return d;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function computeDiscount(subtotal, discount) {
  if (!discount) return 0;
  const raw = discount.discount_type === "percent"
    ? subtotal * (Number(discount.amount) / 100)
    : Number(discount.amount);
  return Math.min(subtotal, Math.max(0, round2(raw)));
}

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

async function quoteShipment(args) {
  const config = await getActivePricingConfig();

  const straightLineKm = haversine(
    args.pickup_lat,
    args.pickup_lng,
    args.delivery_lat,
    args.delivery_lng,
  );

  // A courier trip whose endpoints are effectively the same is almost always
  // a stale coordinate or an accidental selection. Reject it before pricing.
  const sameLocationThresholdKm = Number(process.env.SAME_LOCATION_THRESHOLD_KM || 0.05);
  if (straightLineKm <= sameLocationThresholdKm) {
    throw new BadRequestError("Pickup and delivery locations must be different.");
  }

  const route = await findRouteOverride(args.pickup_city, args.delivery_city);
  const discount = await loadDiscount(args.discount_code);
  const dmRaw = await roadDistance(
    args.pickup_lat,
    args.pickup_lng,
    args.delivery_lat,
    args.delivery_lng,
  );

  if (process.env.REQUIRE_ROUTED_DISTANCE === "true" && dmRaw.source !== "osrm") {
    throw new BadRequestError(
      "We could not verify the driving distance right now. Please try again in a moment.",
    );
  }

  const dm = {
    distance_km: dmRaw.km,
    duration_minutes: dmRaw.minutes,
    source: dmRaw.source,
  };

  const currency = route?.currency || config.currency;
  let base_fare = 0;
  let distance_fee = 0;
  let time_fee = 0;
  let subtotal = 0;
  const weight_fee = 0;

  if (route) {
    subtotal = round2(Number(route.flat_price));
    base_fare = subtotal;
  } else {
    base_fare = round2(Number(config.base_fare));
    distance_fee = round2(dm.distance_km * Number(config.price_per_km));
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
    currency,
    pricing_config_id: config.id,
    distance_km: dm.distance_km,
    duration_minutes: dm.duration_minutes,
    distance_source: dm.source,
    straight_line_distance_km: round2(straightLineKm),
    surge_multiplier: Number(config.surge_multiplier),
    base_fare,
    distance_fee,
    weight_fee,
    time_fee,
    subtotal,
    discount_code: discount?.code || null,
    discount_amount,
    tax_amount,
    total_price,
    rider_earnings: earnings.rider_earnings,
    moto_earnings: earnings.moto_earnings,
    platform_earnings: earnings.platform_earnings,
    rider_commission_percentage: earnings.rider_commission_percentage,
    moto_commission_percentage: earnings.moto_commission_percentage,
    breakdown_note: route ? "Flat route pricing applied" : "Distance-based pricing",
  };
}

module.exports = { quoteShipment, getActivePricingConfig, loadDiscount, splitEarnings };
