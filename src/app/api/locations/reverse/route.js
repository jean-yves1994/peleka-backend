const { requireAuth } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { reverseGeocode } = require('@/lib/google');

exports.dynamic = 'force-dynamic';

exports.GET = withHandler(async (request) => {
  await requireAuth(request);
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new BadRequestError('Invalid latitude');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new BadRequestError('Invalid longitude');

  const location = await reverseGeocode(lat, lng);
  return ok(location || { address: '', place_id: null, lat, lng });
});
