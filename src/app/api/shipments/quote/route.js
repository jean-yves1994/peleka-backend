const { readJson, rateLimit, getClientIp } = require('@/lib/middleware');
const { quoteShipmentSchema } = require('@/lib/validation');
const { quoteShipment } = require('@/lib/pricing');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  rateLimit(`quote:${getClientIp(request) || 'unknown'}`, { max: 60, windowMs: 60_000 });
  const body = quoteShipmentSchema.parse(await readJson(request));
  return ok(await quoteShipment(body));
});
