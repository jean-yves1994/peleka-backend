const { withTransaction, query } = require('@/lib/db');
const { readJson, rateLimit, getClientIp } = require('@/lib/middleware');
const { registerCustomerSchema } = require('@/lib/validation');
const { hashPassword } = require('@/lib/password');
const { signAccessToken, signRefreshToken, hashToken, ttlToSeconds, REFRESH_TTL } = require('@/lib/jwt');
const { created } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { ConflictError } = require('@/lib/errors');
const { logAudit } = require('@/lib/audit');
const { normalizePhone } = require('@/lib/otp');

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request) => {
  rateLimit(`register:${getClientIp(request) || 'unknown'}`, { max: 10, windowMs: 60_000 });
  const body = registerCustomerSchema.parse(await readJson(request));
  const phone = body.phone ? normalizePhone(body.phone) : null;
  const email = body.email || null;
  // The schema already verifies confirmation fields. Keep the values normalized here.
  const confirmEmail = body.confirm_email || null;
  const confirmPhone = body.confirm_phone ? normalizePhone(body.confirm_phone) : null;
  if (email && confirmEmail !== email) throw new ConflictError('Email addresses do not match');
  if (phone && confirmPhone !== phone) throw new ConflictError('Phone numbers do not match');
  if (body.password !== body.confirm_password) throw new ConflictError('Passwords do not match');

  const existing = await query(
    `SELECT 1 FROM users
      WHERE ($1::citext IS NOT NULL AND email = $1)
         OR ($2::text   IS NOT NULL AND phone = $2)
      LIMIT 1`, [email, phone]
  );
  if (existing.rowCount > 0) throw new ConflictError('An account with that email or phone already exists');

  const password_hash = await hashPassword(body.password);
  const result = await withTransaction(async (client) => {
    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, phone, password_hash, full_name, role, status)
       VALUES ($1,$2,$3,$4,'customer','active')
       RETURNING id, email, phone, full_name, role, status, customer_type,
              contract_customer, credit_limit, outstanding_balance, created_at`,
      [email, phone, password_hash, body.full_name]
    );
    await client.query(`INSERT INTO customer_profiles (user_id) VALUES ($1)`, [user.id]);
    const access_token = signAccessToken(user);
    const { token: refresh_token, jti } = signRefreshToken(user);
    const expires_at = new Date(Date.now() + ttlToSeconds(REFRESH_TTL) * 1000);
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [user.id, hashToken(jti), request.headers.get('user-agent') || null, getClientIp(request), expires_at]
    );
    return { user, access_token, refresh_token };
  });
  await logAudit({ request, actor: { id: result.user.id, role: 'customer' },
    action: 'auth.register', entityType: 'user', entityId: result.user.id,
    data: { via: email ? 'email' : 'phone' } });
  return created(result);
});
