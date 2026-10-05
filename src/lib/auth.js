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
              customer_type, contract_customer, credit_limit, outstanding_balance,
            EXISTS (SELECT 1 FROM customer_profiles cp WHERE cp.user_id = users.id) AS is_customer,
            EXISTS (SELECT 1 FROM rider_profiles rp WHERE rp.user_id = users.id) AS is_rider
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
  const effective = new Set();
  if (user.role === 'admin' || user.role === 'dispatcher') effective.add('admin');
  if (user.is_customer || user.role === 'customer') effective.add('customer');
  if (user.is_rider || user.role === 'rider') effective.add('rider');
  if (effective.has('dispatcher')) effective.add('admin');
  const requested = new Set(roles);
  if (requested.has('dispatcher')) requested.add('admin');
  for (const role of requested) {
    if (effective.has(role)) return user;
  }
  throw new ForbiddenError(`Requires one of roles: ${roles.join(', ')}`);
  return user;
}

module.exports = { requireAuth, requireRole, extractBearer };
