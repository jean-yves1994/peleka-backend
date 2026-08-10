const { withTransaction, query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { pricingConfigSchema } = require('@/lib/validation');
const { ok, created } = require('@/lib/response');
const { BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

/**
 * Admin pricing configs.
 *
 * CHANGED: adds `moto_commission_percentage` — the motorbike owner's share of
 * the fare, alongside the rider's.
 *
 *     rider_commission_percentage   70   → the person doing the delivery
 *     moto_commission_percentage    ??   → whoever owns the motorbike
 *     Peleka                      rest   → 100 − rider − moto
 *
 * Both are the share that party RECEIVES, consistent with your existing
 * rider_commission_percentage default of 70.
 *
 * Two edits from your original: the extra column in the INSERT, and a check
 * that the two shares don't exceed 100. Everything else is untouched.
 *
 * ⚠️ ALSO EDIT `pricingConfigSchema` in @/lib/validation — see VALIDATION.md.
 *    Zod strips unknown keys by default, so without that change
 *    `moto_commission_percentage` is silently dropped before it reaches here
 *    and every config saves with 0.
 */

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request) => {
  const admin = await requireRole(request, ['admin']);
  const body = pricingConfigSchema.parse(await readJson(request));

  // Belt-and-braces alongside the DB CHECK constraint: catching it here gives a
  // message naming both numbers, rather than a raw constraint violation.
  const riderPct = Number(body.rider_commission_percentage ?? 70);
  const motoPct = Number(body.moto_commission_percentage ?? 0);
  if (riderPct + motoPct > 100) {
    throw new BadRequestError(
      `Rider (${riderPct}%) and motorbike (${motoPct}%) commissions add up to `
      + `${riderPct + motoPct}%, which is more than the fare. Reduce them so the `
      + 'total is 100% or less.',
    );
  }

  const config = await withTransaction(async (client) => {
    if (body.is_active) {
      await client.query(`UPDATE pricing_configs SET is_active=FALSE WHERE is_active=TRUE`);
    }
    const { rows: [c] } = await client.query(
      `INSERT INTO pricing_configs
         (name, currency, base_fare, price_per_km, price_per_kg, price_per_minute,
          min_price, max_price, free_km, surge_multiplier, tax_percentage,
          rider_commission_percentage, moto_commission_percentage, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [body.name, body.currency, body.base_fare, body.price_per_km, body.price_per_kg,
       body.price_per_minute, body.min_price, body.max_price ?? null, body.free_km,
       body.surge_multiplier, body.tax_percentage, riderPct, motoPct,
       !!body.is_active, admin.id]
    );
    return c;
  });

  await logAudit({
    request, actor: admin, action: 'pricing.config.created',
    entityType: 'pricing_config', entityId: config.id,
  });

  return created({
    ...config,
    // Derived, so nobody has to work out the remainder by hand.
    platform_commission_percentage: Number((100 - riderPct - motoPct).toFixed(2)),
  });
});

exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const { rows } = await query(
    `SELECT * FROM pricing_configs ORDER BY is_active DESC, updated_at DESC`,
  );
  return ok(rows.map((c) => ({
    ...c,
    platform_commission_percentage: Number(
      (100 - Number(c.rider_commission_percentage ?? 0)
           - Number(c.moto_commission_percentage ?? 0)).toFixed(2),
    ),
  })));
});
