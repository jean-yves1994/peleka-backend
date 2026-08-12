const { requireAuth } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { googlePlacesSearch } = require('@/lib/google');

exports.dynamic = 'force-dynamic';

exports.GET = withHandler(async (request) => {
  await requireAuth(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) throw new BadRequestError('Search query must contain at least 2 characters');

  const lat = url.searchParams.has('lat') ? Number(url.searchParams.get('lat')) : undefined;
  const lng = url.searchParams.has('lng') ? Number(url.searchParams.get('lng')) : undefined;
  if ((lat !== undefined && !Number.isFinite(lat)) || (lng !== undefined && !Number.isFinite(lng))) {
    throw new BadRequestError('Invalid latitude or longitude');
  }

  const places = await googlePlacesSearch(q, {
    latitude: lat, longitude: lng,
    radiusMeters: Number(url.searchParams.get('radius') || 10000),
  });
  return ok(places);
});
