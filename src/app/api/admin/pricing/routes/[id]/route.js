const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { z } = require('zod');
const { ok, noContent } = require('@/lib/response');
const { NotFoundError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
const patchSchema = z.object({
  flat_price: z.number().min(0).optional(),
  is_active: z.boolean().optional(),
  currency: z.string().min(3).max(8).optional(),
}).refine(o => Object.keys(o).length > 0, 'No fields to update');

exports.PATCH = withHandler(async (request, { params }) => {
  await requireRole(request, ['admin']);
  const body = patchSchema.parse(await readJson(request));
  const keys = Object.keys(body);
  const set = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
  const values = keys.map(k => body[k]); values.push(params.id);
  const { rows } = await query(`UPDATE route_prices SET ${set}, updated_at=NOW() WHERE id=$${values.length} RETURNING *`, values);
  if (!rows[0]) throw new NotFoundError('Route price not found');
  return ok(rows[0]);
});
exports.DELETE = withHandler(async (request, { params }) => {
  await requireRole(request, ['admin']);
  const { rowCount } = await query(`DELETE FROM route_prices WHERE id=$1`, [params.id]);
  if (rowCount === 0) throw new NotFoundError('Route price not found');
  return noContent();
});
