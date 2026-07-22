const crypto = require('crypto');
const { query } = require('@/lib/db');
const { readJson, rateLimit, getClientIp } = require('@/lib/middleware');
const { forgotPasswordSchema } = require('@/lib/validation');
const { hashToken } = require('@/lib/jwt');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  rateLimit(`forgot:${getClientIp(request) || 'unknown'}`, { max: 5, windowMs: 60_000 });
  const { email } = forgotPasswordSchema.parse(await readJson(request));
  const { rows } = await query(`SELECT id, email FROM users WHERE email=$1 AND deleted_at IS NULL`, [email]);
  const user = rows[0];
  let devToken = null;
  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60*60*1000);
    await query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
      [user.id, hashToken(rawToken), expires]);
    if (process.env.NODE_ENV !== 'production') devToken = rawToken;
    await logAudit({ request, actor: user, action: 'auth.forgot_password_requested', entityType: 'user', entityId: user.id });
  }
  return ok({
    message: 'If an account exists for that email, a password reset link was sent.',
    ...(devToken ? { _dev_reset_token: devToken } : {}),
  });
});
