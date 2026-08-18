const crypto = require('crypto');
const { query } = require('@/lib/db');
const { readJson, rateLimit, getClientIp } = require('@/lib/middleware');
const { forgotPasswordSchema } = require('@/lib/validation');
const { hashToken } = require('@/lib/jwt');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');
const { normalizePhone, issueOtp } = require('@/lib/otp');
const { sendSms } = require('@/lib/sms');
const { sendPasswordResetEmail } = require('@/lib/email');

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request) => {
  rateLimit(`forgot:${getClientIp(request) || 'unknown'}`, { max: 5, windowMs: 60_000 });
  const { identifier } = forgotPasswordSchema.parse(await readJson(request));
  const value = identifier.trim();
  const looksLikeEmail = value.includes('@');
  const generic = { message: 'If an account exists, recovery instructions have been sent.' };

  if (looksLikeEmail) {
    const emailValue = value.toLowerCase();
    const { rows } = await query(
      `SELECT id, email, full_name FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL LIMIT 1`,
      [emailValue]
    );
    const user = rows[0];
    if (!user) return ok(generic);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await query(`UPDATE password_resets SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`, [user.id]);
    await query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
      [user.id, hashToken(rawToken), expires]);

    const sent = await sendPasswordResetEmail({ to: user.email, fullName: user.full_name, token: rawToken });
    if (!sent.ok && process.env.NODE_ENV === 'production') {
      console.warn('[password-reset] email delivery failed:', sent.error);
    }
    if (sent.ok || process.env.NODE_ENV !== 'production') {
      await logAudit({ request, actor: user, action: 'auth.forgot_password_requested', entityType: 'user', entityId: user.id });
    }
    return ok({ ...generic, method: 'email', ...(process.env.NODE_ENV !== 'production' ? { _dev_reset_token: rawToken } : {}) });
  }

  const phone = normalizePhone(value);
  const { rows } = await query(
    `SELECT id, phone FROM users WHERE phone=$1 AND deleted_at IS NULL LIMIT 1`,
    [phone]
  );
  const user = rows[0];
  if (user) {
    const otp = await issueOtp({ phone, purpose: 'password_reset', ip: getClientIp(request), userAgent: request.headers.get('user-agent') || null });
    const sms = await sendSms(phone, `Your Peleka password reset code is ${otp.code}. It expires in 5 minutes.`);
    if (!sms.ok && process.env.NODE_ENV === 'production') {
      console.warn('[password-reset] SMS delivery failed:', sms.error);
    }
    await logAudit({ request, actor: user, action: 'auth.password_reset_phone_requested', entityType: 'user', entityId: user.id });
  }
  return ok({ ...generic, method: 'phone' });
});
