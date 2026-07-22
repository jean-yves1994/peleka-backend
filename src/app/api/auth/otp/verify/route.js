const crypto = require('crypto');
const { withTransaction } = require('@/lib/db');
const { readJson, rateLimit, getClientIp } = require('@/lib/middleware');
const { otpVerifySchema } = require('@/lib/validation');
const { verifyOtp } = require('@/lib/otp');
const { signAccessToken, signRefreshToken, hashToken, ttlToSeconds, REFRESH_TTL } = require('@/lib/jwt');
const { ok } = require('@/lib/response');
const { BadRequestError, ForbiddenError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  rateLimit(`otp-verify:${getClientIp(request) || 'unknown'}`, { max: 20, windowMs: 60_000 });
  const body = otpVerifySchema.parse(await readJson(request));
  const verified = await verifyOtp({ phone: body.phone, code: body.code });

  const result = await withTransaction(async (client) => {
    let user = (await client.query(
      `SELECT id, email, phone, full_name, role, status FROM users
        WHERE phone=$1 AND deleted_at IS NULL LIMIT 1`, [verified.phone]
    )).rows[0];

    if (!user) {
      if (!body.full_name) throw new BadRequestError('full_name is required to create a new account');
      const unusable = '$2b$12$' + crypto.randomBytes(48).toString('base64').replace(/[+/=]/g, '').slice(0, 53);
      const { rows: [created] } = await client.query(
        `INSERT INTO users (phone, password_hash, full_name, role, status, phone_verified_at)
         VALUES ($1,$2,$3,'customer','active', NOW())
         RETURNING id, email, phone, full_name, role, status`,
        [verified.phone, unusable, body.full_name]
      );
      await client.query(`INSERT INTO customer_profiles (user_id) VALUES ($1)`, [created.id]);
      user = created;
    } else {
      await client.query(`UPDATE users SET phone_verified_at=COALESCE(phone_verified_at, NOW()) WHERE id=$1`, [user.id]);
    }
    if (user.status === 'suspended') throw new ForbiddenError('Account suspended');

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
    action: 'auth.otp.verified', entityType: 'user', entityId: result.user.id,
    data: { phone_last4: verified.phone.slice(-4) } });
  return ok(result);
});
