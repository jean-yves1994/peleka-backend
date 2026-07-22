const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { riderLocationSchema } = require('@/lib/validation');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  const user = await requireRole(request, ['rider']);
  const body = riderLocationSchema.parse(await readJson(request));
  await query(
    `UPDATE rider_profiles SET current_lat=$2, current_lng=$3, last_location_at=NOW() WHERE user_id=$1`,
    [user.id, body.lat, body.lng]
  );
  return ok({ updated_at: new Date().toISOString() });
});
