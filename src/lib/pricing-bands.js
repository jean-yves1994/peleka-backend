/**
 * Distance-band pricing with a three-way fare split.
 *
 *   0 – 10 km   2 000 RWF
 *   10 – 15 km  3 000 RWF
 *   15 – 20 km  5 000 RWF
 *   over 20 km  5 000 + 250/km      ⚠️ my assumption — never specified
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 FIXES A REAL BUG in the version I sent earlier
 *
 * That version read `config.tax_rate` and expected a fraction. Your table has
 * **`tax_percentage NUMERIC(5,2)`** — a percentage. `tax_rate` doesn't exist,
 * so it silently fell back to 0.18 and looked correct by accident.
 *
 * The moment you set Tax % = 18 on the form, the two disagree. And had it read
 * the real column raw, an 18.00 would have been treated as 1800%:
 *
 *     total 2000, taxRate 18 → subtotal 105, tax 1895
 *
 * A 2 000 RWF fare booking 1 895 RWF of VAT. Now reads tax_percentage and
 * divides by 100.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SPLIT
 *
 *     rider_commission_percentage   70   → the person doing the delivery
 *     moto_commission_percentage    ??   → whoever owns the motorbike
 *     platform                    rest   → Peleka
 *
 * Both are the share that party RECEIVES, matching your column's 70.00 default.
 *
 * The three amounts reconcile to the total exactly: rider and moto are rounded,
 * and the platform takes the remainder. Three independent roundings would
 * otherwise leave a franc unaccounted for and payouts wouldn't balance.
 */
const { query } = require('@/lib/db');

/** Round to whole RWF. Rwandan francs have no subunit in practice. */
function roundRwf(n) {
  return Math.round(Number(n));
}

/** Pick the band a distance falls into. Bands ascending by min_km. */
function selectBand(bands, distanceKm) {
  const d = Number(distanceKm);

  for (const b of bands) {
    const min = Number(b.min_km);
    const max = b.max_km === null || b.max_km === undefined ? null : Number(b.max_km);
    if (d >= min && (max === null || d < max)) return b;
  }

  // Below the lowest band — fall back to the cheapest rather than failing.
  // Undercharging beats a 500 error on a live booking.
  return bands.length ? bands[0] : null;
}

async function loadBands(pricingConfigId) {
  const { rows } = await query(
    `SELECT * FROM pricing_bands
      WHERE pricing_config_id = $1 AND is_active = TRUE
      ORDER BY min_km ASC`,
    [pricingConfigId],
  );
  return rows;
}

/**
 * Split a total three ways so the parts sum to it exactly.
 *
 * The platform takes the remainder rather than its own rounded percentage —
 * otherwise the parts can miss the total by a franc and payouts stop
 * reconciling.
 */
function splitFare(total, riderPct, motoPct) {
  const rider = roundRwf((total * riderPct) / 100);
  const moto = roundRwf((total * motoPct) / 100);
  return { rider, moto, platform: total - rider - moto };
}

/**
 * Compute a fare.
 *
 * @param {object} config      row from pricing_configs
 * @param {Array}  bands       rows from pricing_bands, ascending
 * @param {number} distanceKm
 * @param {object} [opts]
 * @param {number} [opts.surgeMultiplier]   defaults to the config's value
 * @param {number} [opts.discountAmount=0]  applied to the tax-inclusive total
 */
function priceFromBands(config, bands, distanceKm, opts = {}) {
  const surge = Number(opts.surgeMultiplier ?? config.surge_multiplier ?? 1) || 1;
  const discount = Number(opts.discountAmount ?? 0) || 0;

  // tax_percentage is a PERCENTAGE (18.00), not a fraction. See header.
  const taxRate = Number(config.tax_percentage ?? 0) / 100;

  const inclusive = config.price_includes_tax !== false;

  const band = selectBand(bands, distanceKm);
  if (!band) {
    throw new Error('No pricing bands configured. Run migration 0009 and seed pricing_bands.');
  }

  let gross = Number(band.price);

  // Per-km surcharge on an open-ended top band.
  const perKm = Number(band.per_km_above_min ?? 0);
  if (perKm > 0) {
    gross += Math.max(0, Number(distanceKm) - Number(band.min_km)) * perKm;
  }

  gross *= surge;
  gross = Math.max(0, gross - discount);

  // Honour the config's floor and ceiling. A heavy discount shouldn't take a
  // delivery below what it costs to run, and max_price caps a long trip.
  const minPrice = Number(config.min_price ?? 0);
  if (minPrice > 0 && gross < minPrice) gross = minPrice;

  const maxPrice = config.max_price === null || config.max_price === undefined
    ? null : Number(config.max_price);
  if (maxPrice !== null && maxPrice > 0 && gross > maxPrice) gross = maxPrice;

  let subtotal;
  let tax;
  let total;

  if (inclusive) {
    // Band price already contains VAT — back it out so the three reconcile.
    total = roundRwf(gross);
    subtotal = roundRwf(total / (1 + taxRate));
    tax = total - subtotal;
  } else {
    subtotal = roundRwf(gross);
    tax = roundRwf(subtotal * taxRate);
    total = subtotal + tax;
  }

  const riderPct = Number(config.rider_commission_percentage ?? 70);
  const motoPct = Number(config.moto_commission_percentage ?? 0);
  const share = splitFare(total, riderPct, motoPct);

  return {
    pricing_config_id: config.id,
    pricing_band_id: band.id,
    band_label: band.label,
    distance_km: Number(distanceKm).toFixed(2),

    // Legacy columns kept populated so existing dashboards and receipts that
    // read them don't start showing blanks.
    base_fare: subtotal.toFixed(2),
    distance_fee: '0.00',
    weight_fee: '0.00',
    time_fee: '0.00',

    surge_multiplier: surge.toFixed(2),
    discount_amount: discount.toFixed(2),
    subtotal: subtotal.toFixed(2),
    tax_amount: tax.toFixed(2),
    total_price: total.toFixed(2),
    currency: band.currency || config.currency || 'RWF',

    // The three-way split, frozen onto the shipment by the caller.
    rider_commission_percentage: riderPct.toFixed(2),
    moto_commission_percentage: motoPct.toFixed(2),
    rider_earnings: share.rider.toFixed(2),
    moto_earnings: share.moto.toFixed(2),
    platform_earnings: share.platform.toFixed(2),
  };
}

/**
 * Load config and bands, then price in one call.
 * Returns null when band pricing is off, so the caller can fall back.
 */
async function quote(distanceKm, opts = {}) {
  const { rows } = await query(
    `SELECT * FROM pricing_configs
      WHERE is_active = TRUE
      ORDER BY updated_at DESC
      LIMIT 1`,
  );
  const config = rows[0];
  if (!config) throw new Error('No active pricing config');
  if (!config.use_distance_bands) return null;

  const bands = await loadBands(config.id);
  return priceFromBands(config, bands, distanceKm, opts);
}

module.exports = {
  quote, priceFromBands, loadBands, selectBand, roundRwf, splitFare,
};
