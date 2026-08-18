const crypto = require('crypto');
const { query } = require('@/lib/db');
const { readJson, rateLimit, getClientIp } = require('@/lib/middleware');
const { verifyPasswordResetPhoneSchema } = require('@/lib/validation');
const { hashToken } = require('@/lib/jwt');
const { ok } = require('@/lib/response');
const { BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { verifyOtp, normalizePhone } = require('@/lib/otp');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request) => {
  rateLimit(`forgot-phone-verify:${getClientIp(request) || 'unknown'}`, { max: 10, windowMs: 60_000 });
  const { phone: rawPhone, code } = verifyPasswordResetPhoneSchema.parse(await readJson(request));
  const phone = normalizePhone(rawPhone);
  const { rows: users } = await query(`SELECT id FROM users WHERE phone=$1 AND deleted_at IS NULL LIMIT 1`, [phone]);
  const user = users[0];
  if (!user) throw new BadRequestError('Invalid verification code');

  const result = await verifyOtp({ phone, code });
  if (result.purpose !== 'password_reset') throw new BadRequestError('Invalid verification code');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  await query(`UPDATE password_resets SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`, [user.id]);
  await query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`, [user.id, hashToken(rawToken), expires]);
  await logAudit({ request, actor: user, action: 'auth.password_reset_phone_verified', entityType: 'user', entityId: user.id });

  return ok({ reset_token: rawToken, expires_at: expires });
});
