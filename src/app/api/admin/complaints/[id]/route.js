const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { z } = require('zod');
const { ok } = require('@/lib/response');
const { NotFoundError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
const patchSchema = z.object({
  status: z.enum(['open','in_review','resolved','rejected']).optional(),
  resolution: z.string().max(2000).optional(),
});

exports.PATCH = withHandler(async (request, { params }) => {
  const admin = await requireRole(request, ['admin','dispatcher']);
  const body = patchSchema.parse(await readJson(request));
  const resolvedAt = ['resolved','rejected'].includes(body.status) ? new Date() : null;
  const { rows } = await query(
    `UPDATE complaints SET
       status=COALESCE($2, status),
       resolution=COALESCE($3, resolution),
       handled_by=$4,
       resolved_at=COALESCE($5, resolved_at)
     WHERE id=$1 RETURNING *`,
    [params.id, body.status || null, body.resolution || null, admin.id, resolvedAt]
  );
  if (!rows[0]) throw new NotFoundError('Complaint not found');
  await logAudit({ request, actor: admin, action: 'complaint.updated', entityType: 'complaint', entityId: params.id, data: body });
  return ok(rows[0]);
});
