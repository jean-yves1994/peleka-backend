/**
 * POST /api/auth/firebase-phone
 * Body: { id_token, full_name? }
 *
 * The Flutter app runs Firebase Phone Auth on-device (Firebase handles
 * SMS delivery + code entry). It then forwards the resulting Firebase
 * ID token here. We verify the token, look up (or create) the Peleka
 * user keyed by phone number, and issue our own JWT access + refresh
 * pair — same shape as /api/auth/login and /api/auth/otp/verify so the
 * client can treat all three flows identically.
 *
 * `full_name` is required only when creating a brand-new customer.
 */
const crypto = require('crypto');
const { z } = require('zod');
const { withTransaction } = require('@/lib/db');
const { readJson, rateLimit, getClientIp } = require('@/lib/middleware');
const { verifyFirebaseIdToken } = require('@/lib/firebase');
const {
  signAccessToken, signRefreshToken, hashToken, ttlToSeconds, REFRESH_TTL,
} = require('@/lib/jwt');
const { ok } = require('@/lib/response');
const { BadRequestError, ForbiddenError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

const schema = z.object({
  id_token: z.string().min(20),
  full_name: z.string().trim().min(2).max(160).optional(),
});

exports.POST = withHandler(async (request) => {
  rateLimit(`firebase-phone:${getClientIp(request) || 'unknown'}`, {
    max: 20, windowMs: 60_000,
  });
  const body = schema.parse(await readJson(request));
  const fb = await verifyFirebaseIdToken(body.id_token);

  if (!fb.phone) {
    throw new BadRequestError('Firebase token has no phone_number claim');
  }

  const result = await withTransaction(async (client) => {
    // 1) Find existing user by phone
    let user = (await client.query(
      `SELECT id, email, phone, full_name, role, status
         FROM users
        WHERE phone = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [fb.phone]
    )).rows[0];

    // 2) Create if missing
    if (!user) {
      if (!body.full_name) {
        throw new BadRequestError('full_name is required to create a new account');
      }
      // Unusable password — user can only log in via Firebase or later set one
      // via /api/me/password. Cryptographically valid bcrypt hash of random bytes.
      const unusable =
        '$2b$12$' +
        crypto.randomBytes(48).toString('base64').replace(/[+/=]/g, '').slice(0, 53);

      const { rows: [created] } = await client.query(
        `INSERT INTO users
            (phone, password_hash, full_name, role, status, phone_verified_at)
         VALUES ($1, $2, $3, 'customer', 'active', NOW())
         RETURNING id, email, phone, full_name, role, status`,
        [fb.phone, unusable, body.full_name]
      );
      await client.query(
        `INSERT INTO customer_profiles (user_id) VALUES ($1)`,
        [created.id]
      );
      user = created;
    } else {
      // Bump phone_verified_at (idempotent) — Firebase just proved the number
      await client.query(
        `UPDATE users SET phone_verified_at = COALESCE(phone_verified_at, NOW())
          WHERE id = $1`,
        [user.id]
      );
    }

    if (user.status === 'suspended') throw new ForbiddenError('Account suspended');
    if (user.status !== 'active') throw new ForbiddenError('Account not active');

    // 3) Issue Peleka JWTs
    const access_token = signAccessToken(user);
    const { token: refresh_token, jti } = signRefreshToken(user);
    const expires_at = new Date(Date.now() + ttlToSeconds(REFRESH_TTL) * 1000);
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        user.id,
        hashToken(jti),
        request.headers.get('user-agent') || null,
        getClientIp(request),
        expires_at,
      ]
    );
    await client.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    return { user, access_token, refresh_token };
  });

  await logAudit({
    request,
    actor: { id: result.user.id, role: result.user.role },
    action: 'auth.firebase_phone',
    entityType: 'user',
    entityId: result.user.id,
    data: {
      firebase_uid: fb.uid,
      phone_last4: fb.phone.slice(-4),
    },
  });

  return ok(result);
});
