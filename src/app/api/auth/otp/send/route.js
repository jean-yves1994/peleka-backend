const { readJson, rateLimit, getClientIp, getUserAgent } = require('@/lib/middleware');
const { otpSendSchema } = require('@/lib/validation');
const { issueOtp } = require('@/lib/otp');
const { sendSms } = require('@/lib/sms');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  rateLimit(`otp:${getClientIp(request) || 'unknown'}`, { max: 10, windowMs: 60_000 });
  const body = otpSendSchema.parse(await readJson(request));
  const issued = await issueOtp({
    phone: body.phone, purpose: body.purpose || 'login',
    ip: getClientIp(request), userAgent: getUserAgent(request),
  });
  const message = `Peleka: your verification code is ${issued.code}. It expires in 5 minutes.`;
  const smsResult = await sendSms(issued.phone, message);
  await logAudit({ request, action: 'auth.otp.sent', entityType: 'phone_otp', entityId: issued.id,
    data: { phone_last4: issued.phone.slice(-4), delivered: !!smsResult.ok } });

  const payload = { message: 'If the number is valid, a code has been sent.', expires_at: issued.expires_at };
  if (process.env.NODE_ENV !== 'production') payload._dev_code = issued.code;
  return ok(payload);
});
