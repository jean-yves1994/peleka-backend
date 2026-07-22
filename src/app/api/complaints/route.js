const { query } = require('@/lib/db');
const { readJson, parseListParams } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { complaintSchema } = require('@/lib/validation');
const { created, paginated } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  const body = complaintSchema.parse(await readJson(request));
  const attachments = (body.attachments || []).map(a => ({
    url: a.url,
    mime_type: a.mime_type || null,
    size: typeof a.size === 'number' ? a.size : null,
    uploaded_at: new Date().toISOString(),
  }));
  const { rows: [c] } = await query(
    `INSERT INTO complaints (shipment_id, raised_by, category, subject, description, attachments)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
    [body.shipment_id || null, user.id, body.category, body.subject, body.description, JSON.stringify(attachments)]
  );
  await logAudit({ request, actor: user, action: 'complaint.created',
    entityType: 'complaint', entityId: c.id,
    data: { category: body.category, attachments: attachments.length } });
  return created(c);
});
exports.GET = withHandler(async (request) => {
  const user = await requireAuth(request);
  const { page, pageSize, offset } = parseListParams(request);
  const { rows } = await query(`SELECT * FROM complaints WHERE raised_by=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [user.id, pageSize, offset]);
  const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM complaints WHERE raised_by=$1`, [user.id]);
  return paginated(rows, { page, pageSize, total: count });
});
