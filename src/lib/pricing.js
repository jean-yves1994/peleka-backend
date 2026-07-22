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
async function quoteShipment(args) {
  const config = await getActivePricingConfig();
  const route = await findRouteOverride(args.pickup_city, args.delivery_city);
  const discount = await loadDiscount(args.discount_code);
  const dm = await getDistanceMatrix(
    { lat: args.pickup_lat, lng: args.pickup_lng },
    { lat: args.delivery_lat, lng: args.delivery_lng }
  );

  const currency = route?.currency || config.currency;
  let base_fare = 0, distance_fee = 0, weight_fee = 0, time_fee = 0, subtotal = 0;

  if (route) {
    subtotal = round2(Number(route.flat_price));
    base_fare = subtotal;
  } else {
    base_fare = round2(Number(config.base_fare));
    const billableKm = Math.max(0, dm.distance_km - Number(config.free_km || 0));
    distance_fee = round2(billableKm * Number(config.price_per_km));
    weight_fee = round2(Number(args.parcel_weight_kg || 0) * Number(config.price_per_kg));
    time_fee = round2(dm.duration_minutes * Number(config.price_per_minute));
    let raw = base_fare + distance_fee + weight_fee + time_fee;
    raw *= Number(config.surge_multiplier || 1);
    if (raw < Number(config.min_price)) raw = Number(config.min_price);
    if (config.max_price && raw > Number(config.max_price)) raw = Number(config.max_price);
    subtotal = round2(raw);
  }

  const discount_amount = computeDiscount(subtotal, discount);
  const afterDiscount = round2(subtotal - discount_amount);
  const tax_amount = round2(afterDiscount * (Number(config.tax_percentage) / 100));
  const total_price = round2(afterDiscount + tax_amount);
  const rider_earnings = round2(afterDiscount * (Number(config.rider_commission_percentage) / 100));

  return {
    currency, pricing_config_id: config.id,
    distance_km: dm.distance_km, duration_minutes: dm.duration_minutes, distance_source: dm.source,
    surge_multiplier: Number(config.surge_multiplier),
    base_fare, distance_fee, weight_fee, time_fee, subtotal,
    discount_code: discount?.code || null, discount_amount,
    tax_amount, total_price, rider_earnings,
    breakdown_note: route ? 'Flat route pricing applied' : 'Standard distance-based pricing',
  };
}
module.exports = { quoteShipment, getActivePricingConfig, loadDiscount };
