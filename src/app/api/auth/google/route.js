const crypto = require('crypto');
const { withTransaction } = require('@/lib/db');
const { readJson, rateLimit, getClientIp } = require('@/lib/middleware');
const { googleAuthSchema } = require('@/lib/validation');
const { verifyGoogleIdToken } = require('@/lib/google');
const { signAccessToken, signRefreshToken, hashToken, ttlToSeconds, REFRESH_TTL } = require('@/lib/jwt');
const { ok } = require('@/lib/response');
const { ForbiddenError, UnauthorizedError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  rateLimit(`google:${getClientIp(request) || 'unknown'}`, { max: 20, windowMs: 60_000 });
  const body = googleAuthSchema.parse(await readJson(request));
  const g = await verifyGoogleIdToken(body.id_token);
  if (!g.email_verified) throw new UnauthorizedError('Google email is not verified');

  const result = await withTransaction(async (client) => {
    let user = (await client.query(
      `SELECT id, email, phone, full_name, role, status FROM users
        WHERE google_sub=$1 AND deleted_at IS NULL LIMIT 1`, [g.sub]
    )).rows[0];

    if (!user) {
      user = (await client.query(
        `SELECT id, email, phone, full_name, role, status FROM users
          WHERE email=$1 AND deleted_at IS NULL LIMIT 1`, [g.email]
      )).rows[0];
      if (user) await client.query(
        `UPDATE users SET google_sub=$1, email_verified_at=COALESCE(email_verified_at, NOW()) WHERE id=$2`,
        [g.sub, user.id]
      );
    }
    if (!user) {
      const unusable = '$2b$12$' + crypto.randomBytes(48).toString('base64').replace(/[+/=]/g, '').slice(0, 53);
      const { rows: [created] } = await client.query(
        `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at, google_sub, avatar_url)
         VALUES ($1,$2,$3,'customer','active', NOW(), $4, $5)
         RETURNING id, email, phone, full_name, role, status`,
        [g.email, unusable, g.name, g.sub, g.picture]
      );
      await client.query(`INSERT INTO customer_profiles (user_id) VALUES ($1)`, [created.id]);
      user = created;
    }
    if (user.status === 'suspended') throw new ForbiddenError('Account suspended');
    if (user.status !== 'active') throw new UnauthorizedError('Account not active');

    const access_token = signAccessToken(user);
    const { token: refresh_token, jti } = signRefreshToken(user);
    const expires_at = new Date(Date.now() + ttlToSeconds(REFRESH_TTL) * 1000);
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [user.id, hashToken(jti), request.headers.get('user-agent') || null, getClientIp(request), expires_at]
    );
    await client.query(`UPDATE users SET last_login_at=NOW() WHERE id=$1`, [user.id]);
    return { user, access_token, refresh_token };
  });
  await logAudit({ request, actor: { id: result.user.id, role: result.user.role },
    action: 'auth.google', entityType: 'user', entityId: result.user.id,
    data: { email: g.email, sub: g.sub } });
  return ok(result);
});
