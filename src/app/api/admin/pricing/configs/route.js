const { withTransaction, query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { pricingConfigSchema } = require('@/lib/validation');
const { ok, created } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  const admin = await requireRole(request, ['admin']);
  const body = pricingConfigSchema.parse(await readJson(request));
  const config = await withTransaction(async (client) => {
    if (body.is_active) await client.query(`UPDATE pricing_configs SET is_active=FALSE WHERE is_active=TRUE`);
    const { rows: [c] } = await client.query(
      `INSERT INTO pricing_configs
         (name, currency, base_fare, price_per_km, price_per_kg, price_per_minute,
          min_price, max_price, free_km, surge_multiplier, tax_percentage,
          rider_commission_percentage, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [body.name, body.currency, body.base_fare, body.price_per_km, body.price_per_kg,
       body.price_per_minute, body.min_price, body.max_price ?? null, body.free_km,
       body.surge_multiplier, body.tax_percentage, body.rider_commission_percentage,
       !!body.is_active, admin.id]
    );
    return c;
  });
  await logAudit({ request, actor: admin, action: 'pricing.config.created', entityType: 'pricing_config', entityId: config.id });
  return created(config);
});
exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const { rows } = await query(`SELECT * FROM pricing_configs ORDER BY is_active DESC, updated_at DESC`);
  return ok(rows);
});
