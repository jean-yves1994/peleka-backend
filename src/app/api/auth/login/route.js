const { query } = require("@/lib/db");
const { readJson, rateLimit, getClientIp } = require("@/lib/middleware");
const { loginSchema } = require("@/lib/validation");
const { verifyPassword } = require("@/lib/password");
const {
  signAccessToken,
  signRefreshToken,
  hashToken,
  ttlToSeconds,
  REFRESH_TTL,
} = require("@/lib/jwt");
const { ok } = require("@/lib/response");
const { UnauthorizedError, ForbiddenError } = require("@/lib/errors");
const { withHandler } = require("@/lib/route-helpers");
const { logAudit } = require("@/lib/audit");
const { normalizePhone } = require("@/lib/otp");

exports.dynamic = "force-dynamic";

//This block is used to handle the login route. It checks the user's credentials, verifies their password, and generates access and refresh tokens if the credentials are valid. It also logs the login attempt for auditing purposes.
exports.POST = withHandler(async (request) => {
  rateLimit(`login:${getClientIp(request) || "unknown"}`, {
    max: 20,
    windowMs: 60_000,
  });
  const body = loginSchema.parse(await readJson(request));
  const phone = body.phone ? normalizePhone(body.phone) : null;

  const { rows } = await query(
    `SELECT id, email, phone, full_name, role, status, password_hash
       FROM users
      WHERE (($1::citext IS NOT NULL AND email = $1) OR ($2::text IS NOT NULL AND phone = $2))
        AND deleted_at IS NULL LIMIT 1`,
    [body.email || null, phone],
  );
  const user = rows[0];
  if (!user) throw new UnauthorizedError("Invalid credentials");
  const passwordOk = await verifyPassword(body.password, user.password_hash);
  if (!passwordOk) throw new UnauthorizedError("Invalid credentials");
  if (user.status === "suspended")
    throw new ForbiddenError("Account suspended");
  if (user.status !== "active")
    throw new UnauthorizedError("Account not active");

  const access_token = signAccessToken(user);
  const { token: refresh_token, jti } = signRefreshToken(user);
  const expires_at = new Date(Date.now() + ttlToSeconds(REFRESH_TTL) * 1000);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      user.id,
      hashToken(jti),
      request.headers.get("user-agent") || null,
      getClientIp(request),
      expires_at,
    ],
  );
  await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [
    user.id,
  ]);
  await logAudit({
    request,
    actor: { id: user.id, role: user.role },
    action: "auth.login",
    entityType: "user",
    entityId: user.id,
    data: { via: body.email ? "email" : "phone" },
  });

  const { password_hash, ...safe } = user;
  return ok({ user: safe, access_token, refresh_token });
});
