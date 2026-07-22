const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { updateProfileSchema } = require('@/lib/validation');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

exports.GET = withHandler(async (request) => {
  const user = await requireAuth(request);
  let profile = null;
  if (user.role === 'customer') {
    const { rows } = await query(`SELECT * FROM customer_profiles WHERE user_id=$1`, [user.id]);
    profile = rows[0] || null;
  } else if (user.role === 'rider') {
    const { rows } = await query(`SELECT * FROM rider_profiles WHERE user_id=$1`, [user.id]);
    profile = rows[0] || null;
  }
  return ok({ user, profile });
});

exports.PATCH = withHandler(async (request) => {
  const user = await requireAuth(request);
  const body = updateProfileSchema.parse(await readJson(request));
  const userFields = {};
  if (body.full_name !== undefined) userFields.full_name = body.full_name;
  if (body.phone !== undefined) userFields.phone = body.phone;
  if (body.avatar_url !== undefined) userFields.avatar_url = body.avatar_url;
  if (Object.keys(userFields).length) {
    const keys = Object.keys(userFields);
    const vals = Object.values(userFields);
    const set = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
    await query(`UPDATE users SET ${set} WHERE id=$${keys.length + 1}`, [...vals, user.id]);
  }
  if (user.role === 'customer' &&
      (body.default_address !== undefined || body.default_lat !== undefined || body.default_lng !== undefined)) {
    await query(
      `UPDATE customer_profiles
          SET default_address = COALESCE($2, default_address),
              default_lat     = COALESCE($3, default_lat),
              default_lng     = COALESCE($4, default_lng)
        WHERE user_id=$1`,
      [user.id, body.default_address ?? null, body.default_lat ?? null, body.default_lng ?? null]
    );
  }
  await logAudit({ request, actor: user, action: 'user.profile_updated', entityType: 'user', entityId: user.id, data: body });
  const { rows } = await query(
    `SELECT id, email, phone, full_name, role, status, avatar_url, created_at, updated_at
       FROM users WHERE id=$1`, [user.id]
  );
  return ok({ user: rows[0] });
});
