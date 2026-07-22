const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { deviceTokenSchema } = require('@/lib/validation');
const { ok, created } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  const { platform, token } = deviceTokenSchema.parse(await readJson(request));
  const { rows } = await query(
    `INSERT INTO device_tokens (user_id, platform, token, is_active)
       VALUES ($1,$2,$3,TRUE)
     ON CONFLICT (user_id, token) DO UPDATE
       SET is_active=TRUE, platform=EXCLUDED.platform, updated_at=NOW()
     RETURNING *`, [user.id, platform, token]
  );
  return created(rows[0]);
});
exports.DELETE = withHandler(async (request) => {
  const user = await requireAuth(request);
  const { token } = await readJson(request);
  await query(`UPDATE device_tokens SET is_active=FALSE WHERE user_id=$1 AND token=$2`, [user.id, token]);
  return ok({ message: 'Device token deactivated' });
});
