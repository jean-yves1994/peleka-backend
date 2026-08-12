/**
 * Auth guards. Usage:
 *   const user = await requireAuth(request);
 *   const user = await requireRole(request, ['admin']);
 */
const { verifyAccessToken } = require('./jwt');
const { query } = require('./db');
const { UnauthorizedError, ForbiddenError } = require('./errors');

function extractBearer(request) {
  const header = request.headers.get('authorization') || request.headers.get('Authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

async function requireAuth(request) {
  const token = extractBearer(request);
  if (!token) throw new UnauthorizedError('Missing Bearer token');
  const payload = verifyAccessToken(token);
  if (payload.typ !== 'access') throw new UnauthorizedError('Wrong token type');
  const { rows } = await query(
    `SELECT id, email, phone, full_name, role, status, avatar_url, created_at,
              customer_type, contract_customer, credit_limit, outstanding_balance
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [payload.sub]
  );
  const user = rows[0];
  if (!user) throw new UnauthorizedError('User not found');
  if (user.status === 'suspended') throw new ForbiddenError('Account suspended');
  if (user.status !== 'active') throw new UnauthorizedError('Account not active');
  return user;
}

async function requireRole(request, allowed) {
  const user = await requireAuth(request);
  const roles = Array.isArray(allowed) ? allowed : [allowed];
  const effective = new Set(roles);
  if (effective.has('dispatcher')) effective.add('admin');
  if (!effective.has(user.role)) throw new ForbiddenError(`Requires one of roles: ${roles.join(', ')}`);
  return user;
}

module.exports = { requireAuth, requireRole, extractBearer };
