const { withTransaction } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireRole } = require('@/lib/auth');
const { assignmentResponseSchema } = require('@/lib/validation');
const { ok } = require('@/lib/response');
const { NotFoundError, ForbiddenError, ConflictError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request, { params }) => {
  const user = await requireRole(request, ['rider']);
  const body = assignmentResponseSchema.parse(await readJson(request).catch(() => ({})));
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM shipment_assignments WHERE id=$1 FOR UPDATE`, [params.id]);
    const a = rows[0];
    if (!a) throw new NotFoundError('Assignment not found');
    if (a.rider_id !== user.id) throw new ForbiddenError();
    if (a.status !== 'offered') throw new ConflictError(`Assignment is "${a.status}"`);
    const { rows: [rejected] } = await client.query(
      `UPDATE shipment_assignments SET status='rejected', responded_at=NOW(), reject_reason=$2
        WHERE id=$1 RETURNING *`, [a.id, body.reject_reason || null]
    );
    const others = await client.query(
      `SELECT 1 FROM shipment_assignments WHERE shipment_id=$1 AND status='offered' LIMIT 1`, [a.shipment_id]
    );
    if (others.rowCount === 0) {
      await client.query(`UPDATE shipments SET status='awaiting_assignment' WHERE id=$1 AND status='assigned'`, [a.shipment_id]);
    }
    return rejected;
  });
  await logAudit({ request, actor: user, action: 'assignment.rejected',
    entityType: 'shipment_assignment', entityId: params.id, data: { reason: body.reject_reason } });
  return ok(result);
});
