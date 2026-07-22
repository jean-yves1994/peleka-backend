const { query } = require('@/lib/db');
const { readJson, parseListParams } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { discountSchema } = require('@/lib/validation');
const { created, paginated } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  const admin = await requireRole(request, ['admin']);
  const body = discountSchema.parse(await readJson(request));
  const { rows: [d] } = await query(
    `INSERT INTO discounts (code, description, discount_type, amount, max_uses, valid_from, valid_to, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, TRUE)) RETURNING *`,
    [body.code, body.description || null, body.discount_type, body.amount,
     body.max_uses || null, body.valid_from || null, body.valid_to || null, body.is_active]
  );
  await logAudit({ request, actor: admin, action: 'discount.created', entityType: 'discount', entityId: d.id });
  return created(d);
});
exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const { page, pageSize, offset } = parseListParams(request);
  const { rows } = await query(`SELECT * FROM discounts ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [pageSize, offset]);
  const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM discounts`);
  return paginated(rows, { page, pageSize, total: count });
});
