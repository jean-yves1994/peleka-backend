const { withTransaction, query } = require('@/lib/db');
const { readJson, getClientIp } = require('@/lib/middleware');
const { refreshSchema } = require('@/lib/validation');
const { verifyRefreshToken, signAccessToken, signRefreshToken, hashToken, ttlToSeconds, REFRESH_TTL } = require('@/lib/jwt');
const { ok } = require('@/lib/response');
const { UnauthorizedError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  const { refresh_token } = refreshSchema.parse(await readJson(request));
  const payload = verifyRefreshToken(refresh_token);
  if (payload.typ !== 'refresh') throw new UnauthorizedError('Wrong token type');
  const jtiHash = hashToken(payload.jti);
  const existing = await query(
    `SELECT rt.id, rt.revoked_at, rt.expires_at, u.id AS user_id, u.email, u.role, u.status
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = $1`,
    [jtiHash]
  );
  const row = existing.rows[0];
  if (!row) throw new UnauthorizedError('Refresh token not recognized');
  if (row.revoked_at) throw new UnauthorizedError('Refresh token revoked');
  if (new Date(row.expires_at) < new Date()) throw new UnauthorizedError('Refresh token expired');
  if (row.status !== 'active') throw new UnauthorizedError('Account not active');

  const user = { id: row.user_id, email: row.email, role: row.role };
  const access_token = signAccessToken(user);
  const { token: new_refresh, jti: newJti } = signRefreshToken(user);
  const expires_at = new Date(Date.now() + ttlToSeconds(REFRESH_TTL) * 1000);
  await withTransaction(async (client) => {
    const { rows: [inserted] } = await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [user.id, hashToken(newJti), request.headers.get('user-agent') || null, getClientIp(request), expires_at]
    );
    await client.query(`UPDATE refresh_tokens SET revoked_at=NOW(), replaced_by=$2 WHERE id=$1`, [row.id, inserted.id]);
  });
  return ok({ access_token, refresh_token: new_refresh });
});
