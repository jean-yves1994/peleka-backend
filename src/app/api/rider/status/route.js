const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { updateRiderStatusSchema } = require('@/lib/validation');
const { ok } = require('@/lib/response');
const { ForbiddenError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
const RIDER_SELF_ALLOWED = new Set(['online','offline','busy']);
exports.PATCH = withHandler(async (request) => {
  const user = await requireRole(request, ['rider']);
  const { status } = updateRiderStatusSchema.parse(await readJson(request));
  if (!RIDER_SELF_ALLOWED.has(status)) throw new ForbiddenError('Only admins may set this status');
  const { rows } = await query(`UPDATE rider_profiles SET status=$2 WHERE user_id=$1 RETURNING *`, [user.id, status]);
  return ok(rows[0]);
});
