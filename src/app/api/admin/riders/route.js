const { withTransaction, query } = require('@/lib/db');
const { readJson, parseListParams } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { createRiderSchema } = require('@/lib/validation');
const { hashPassword } = require('@/lib/password');
const { created, paginated } = require('@/lib/response');
const { ConflictError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  const admin = await requireRole(request, ['admin']);
  const body = createRiderSchema.parse(await readJson(request));
  const dup = await query(`SELECT 1 FROM users WHERE email=$1 OR (phone IS NOT NULL AND phone=$2)`, [body.email, body.phone || null]);
  if (dup.rowCount > 0) throw new ConflictError('A user with that email or phone already exists');
  const password_hash = await hashPassword(body.password);
  const result = await withTransaction(async (client) => {
    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, phone, password_hash, full_name, role, status, email_verified_at)
       VALUES ($1,$2,$3,$4,'rider','active', NOW())
       RETURNING id, email, phone, full_name, role, status, created_at`,
      [body.email, body.phone, password_hash, body.full_name]
    );
    const { rows: [profile] } = await client.query(
      `INSERT INTO rider_profiles (user_id, status, vehicle_type, vehicle_plate, license_number, national_id)
       VALUES ($1,'pending_approval',$2,$3,$4,$5) RETURNING *`,
      [user.id, body.vehicle_type, body.vehicle_plate || null, body.license_number || null, body.national_id || null]
    );
    return { user, profile };
  });
  await logAudit({ request, actor: admin, action: 'rider.created', entityType: 'user', entityId: result.user.id });
  return created(result);
});

exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const { page, pageSize, offset, q } = parseListParams(request);
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const filters = [`u.role='rider'`, `u.deleted_at IS NULL`];
  const params = [];
  if (status) { params.push(status); filters.push(`rp.status=$${params.length}::rider_status`); }
  if (q) { params.push(`%${q}%`); filters.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`); }
  const where = `WHERE ${filters.join(' AND ')}`;
  const listParams = [...params, pageSize, offset];
  const { rows } = await query(
    `SELECT u.id, u.email, u.phone, u.full_name, u.status AS account_status,
            u.created_at, u.last_login_at, rp.status, rp.vehicle_type, rp.vehicle_plate,
            rp.rating_avg, rp.rating_count, rp.completed_jobs,
            rp.current_lat, rp.current_lng, rp.last_location_at
       FROM users u LEFT JOIN rider_profiles rp ON rp.user_id=u.id
       ${where} ORDER BY u.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams
  );
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM users u LEFT JOIN rider_profiles rp ON rp.user_id=u.id ${where}`, params
  );
  return paginated(rows, { page, pageSize, total: count });
});
