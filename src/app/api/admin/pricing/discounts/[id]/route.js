const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { discountSchema } = require('@/lib/validation');
const { ok, noContent } = require('@/lib/response');
const { NotFoundError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.PATCH = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin']);
  const body = discountSchema.partial().parse(await readJson(request));
  const keys = Object.keys(body);
  if (keys.length === 0) {
    const { rows } = await query(`SELECT * FROM discounts WHERE id=$1`, [params.id]);
    if (!rows[0]) throw new NotFoundError('Discount not found');
    return ok(rows[0]);
  }
  const set = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
  const values = keys.map(k => body[k]); values.push(params.id);
  const { rows } = await query(`UPDATE discounts SET ${set} WHERE id=$${values.length} RETURNING *`, values);
  if (!rows[0]) throw new NotFoundError('Discount not found');
  await logAudit({ request, actor: admin, action: 'discount.updated', entityType: 'discount', entityId: params.id });
  return ok(rows[0]);
});
exports.DELETE = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin']);
  const { rowCount } = await query(`DELETE FROM discounts WHERE id=$1`, [params.id]);
  if (rowCount === 0) throw new NotFoundError('Discount not found');
  await logAudit({ request, actor: admin, action: 'discount.deleted', entityType: 'discount', entityId: params.id });
  return noContent();
});
