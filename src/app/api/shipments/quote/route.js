const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { quoteShipmentSchema } = require('@/lib/validation');
const { quoteShipment } = require('@/lib/pricing');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { query } = require('@/lib/db');
const { BadRequestError } = require('@/lib/errors');

exports.dynamic = 'force-dynamic';

/**
 * POST /api/shipments/quote
 *
 * Price preview only. It uses the same quoteShipment() function as shipment
 * creation, so the preview and the final server-side charge cannot use two
 * different pricing algorithms.
 */
exports.POST = withHandler(async (request) => {
  const user = await requireRole(request, ['customer']);
  const body = quoteShipmentSchema.parse(await readJson(request));

  if (body.pickup_lat === body.delivery_lat && body.pickup_lng === body.delivery_lng) {
    throw new BadRequestError('Pickup and delivery locations must be different.');
  }

  const quote = await quoteShipment(body);

  const { rows: [customer] } = await query(
    `SELECT customer_type, contract_customer FROM users WHERE id=$1`,
    [user.id],
  );
  const isPremier =
    customer?.customer_type === 'premier' || customer?.contract_customer === true;

  return ok({
    ...quote,
    payment_required: !isPremier,
  });
});
