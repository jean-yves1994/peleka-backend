const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { UnauthorizedError } = require('./errors');

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || 'dev-access-secret-change-me';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me';
const ACCESS_TTL     = process.env.JWT_ACCESS_TTL  || '15m';
const REFRESH_TTL    = process.env.JWT_REFRESH_TTL || '30d';

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, typ: 'access' },
    ACCESS_SECRET,
    { expiresIn: ACCESS_TTL, issuer: 'peleka', audience: 'peleka-clients' }
  );
}
function signRefreshToken(user) {
  const jti = uuidv4();
  const token = jwt.sign(
    { sub: user.id, role: user.role, typ: 'refresh', jti },
    REFRESH_SECRET,
    { expiresIn: REFRESH_TTL, issuer: 'peleka', audience: 'peleka-clients' }
  );
  return { token, jti };
}
function verifyAccessToken(token) {
  try { return jwt.verify(token, ACCESS_SECRET, { issuer: 'peleka', audience: 'peleka-clients' }); }
  catch { throw new UnauthorizedError('Invalid or expired access token'); }
}
function verifyRefreshToken(token) {
  try { return jwt.verify(token, REFRESH_SECRET, { issuer: 'peleka', audience: 'peleka-clients' }); }
  catch { throw new UnauthorizedError('Invalid or expired refresh token'); }
}
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function ttlToSeconds(ttl) {
  const m = /^(\d+)\s*([smhd])$/i.exec(String(ttl).trim());
  if (!m) return 900;
  const n = Number(m[1]);
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()]);
}
module.exports = { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken,
  hashToken, ttlToSeconds, ACCESS_TTL, REFRESH_TTL };
