const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { z } = require('zod');
const { ok, created } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
const routeSchema = z.object({
  origin_city: z.string().min(2).max(120),
  destination_city: z.string().min(2).max(120),
  flat_price: z.number().min(0),
  currency: z.string().min(3).max(8).default('USD'),
  is_active: z.boolean().optional(),
});
exports.POST = withHandler(async (request) => {
  const admin = await requireRole(request, ['admin']);
  const body = routeSchema.parse(await readJson(request));
  const { rows: [r] } = await query(
    `INSERT INTO route_prices (origin_city, destination_city, flat_price, currency, is_active)
     VALUES ($1,$2,$3,$4, COALESCE($5, TRUE))
     ON CONFLICT (origin_city, destination_city) DO UPDATE
       SET flat_price=EXCLUDED.flat_price, currency=EXCLUDED.currency,
           is_active=EXCLUDED.is_active, updated_at=NOW()
     RETURNING *`,
    [body.origin_city, body.destination_city, body.flat_price, body.currency, body.is_active]
  );
  await logAudit({ request, actor: admin, action: 'route_price.upserted', entityType: 'route_price', entityId: r.id });
  return created(r);
});
exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const { rows } = await query(`SELECT * FROM route_prices ORDER BY origin_city, destination_city`);
  return ok(rows);
});
