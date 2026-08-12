const { withTransaction, query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { pricingConfigSchema } = require('@/lib/validation');
const { ok } = require('@/lib/response');
const { NotFoundError, BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.GET = withHandler(async (request, { params }) => {
  await requireRole(request, ['admin','dispatcher']);
  const { rows } = await query(`SELECT * FROM pricing_configs WHERE id=$1`, [params.id]);
  if (!rows[0]) throw new NotFoundError('Pricing config not found');
  const { price_per_kg, free_km, ...publicConfig } = rows[0];
  return ok(publicConfig);
});
exports.PATCH = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin']);
  const body = pricingConfigSchema.partial().parse(await readJson(request));
  const current = (await query(`SELECT rider_commission_percentage, moto_commission_percentage FROM pricing_configs WHERE id=$1`, [params.id])).rows[0];
  if (!current) throw new NotFoundError('Pricing config not found');
  const riderPct = Number(body.rider_commission_percentage ?? current.rider_commission_percentage ?? 0);
  const motoPct = Number(body.moto_commission_percentage ?? current.moto_commission_percentage ?? 0);
  if (riderPct + motoPct > 100) {
    throw new BadRequestError('Rider and motorbike commissions cannot exceed 100% combined');
  }
  const updated = await withTransaction(async (client) => {
    if (body.is_active === true)
      await client.query(`UPDATE pricing_configs SET is_active=FALSE WHERE is_active=TRUE AND id<>$1`, [params.id]);
    const keys = Object.keys(body);
    if (keys.length === 0) {
      const { rows } = await client.query(`SELECT * FROM pricing_configs WHERE id=$1`, [params.id]);
      if (!rows[0]) throw new NotFoundError('Pricing config not found');
      return rows[0];
    }
    const setClauses = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
    const values = keys.map(k => body[k]); values.push(params.id);
    const { rows } = await client.query(
      `UPDATE pricing_configs SET ${setClauses} WHERE id=$${values.length} RETURNING *`, values
    );
    if (!rows[0]) throw new NotFoundError('Pricing config not found');
    return rows[0];
  });
  await logAudit({ request, actor: admin, action: 'pricing.config.updated', entityType: 'pricing_config', entityId: params.id });
  const { price_per_kg, free_km, ...publicConfig } = updated;
  return ok(publicConfig);
});
