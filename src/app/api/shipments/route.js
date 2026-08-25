const { readJson } = require("@/lib/middleware");
const { requireAuth } = require("@/lib/auth");
const { quoteShipmentSchema } = require("@/lib/validation");
const { quoteShipment } = require("@/lib/pricing");
const { ok } = require("@/lib/response");
const { withHandler } = require("@/lib/route-helpers");
const { query } = require("@/lib/db");

/**
 * POST /api/shipments/quote — price preview, nothing written.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE FILE THROWING YOUR 400
 *
 * It was calling `quote()` from `@/lib/pricing-bands`, which refuses to price
 * anything unless `pricing_configs.use_distance_bands = TRUE` — a column that
 * doesn't exist in your schema. Hence:
 *
 *     "Distance-band pricing is not enabled. Run migration 009…"
 *
 * It now calls `quoteShipment` from `@/lib/pricing`, the same function shipment
 * creation uses. One pricing path means the preview and the charge can't
 * disagree.
 *
 * Safe to call on every map adjustment — no writes, no side effects.
 */

exports.dynamic = "force-dynamic";

exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  const body = quoteShipmentSchema.parse(await readJson(request));

  const quote = await quoteShipment({
    pickup_lat: body.pickup_lat,
    pickup_lng: body.pickup_lng,
    delivery_lat: body.delivery_lat,
    delivery_lng: body.delivery_lng,
    pickup_city: body.pickup_city,
    delivery_city: body.delivery_city,
    discount_code: body.discount_code,
  });

  // Tell the app whether this customer pays now or gets invoiced, so the button
  // can read "Place order" rather than "Pay 2,500 RWF" on a contract account.
  const {
    rows: [customer],
  } = await query(
    `SELECT customer_type, contract_customer FROM users WHERE id = $1`,
    [user.id],
  );
  const isPremier =
    customer?.customer_type === "premier" ||
    customer?.contract_customer === true;

  return ok({
    ...quote,
    payment_required: !isPremier,
    // Riders' and Peleka's shares are in `quote` for the admin dashboard; the
    // customer app should only ever display total_price.
  });
});
