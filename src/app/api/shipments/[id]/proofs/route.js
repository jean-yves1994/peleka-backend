const { query } = require('@/lib/db');
const { readJson } = require('@/lib/middleware');
const { requireAuth } = require('@/lib/auth');
const { uploadProofSchema } = require('@/lib/validation');
const { saveBufferToStorage, mimeToExt } = require('@/lib/upload');
const { created, ok } = require('@/lib/response');
const { NotFoundError, ForbiddenError, BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

exports.POST = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const { rows } = await query(`SELECT id, rider_id, customer_id, status FROM shipments WHERE id=$1`, [params.id]);
  const s = rows[0];
  if (!s) throw new NotFoundError('Shipment not found');
  const isRider = user.role === 'rider' && s.rider_id === user.id;
  const isAdmin = user.role === 'admin' || user.role === 'dispatcher';
  if (!isRider && !isAdmin) throw new ForbiddenError('Only the assigned rider or an admin can upload proofs');

  const contentType = request.headers.get('content-type') || '';
  let file_url, mime_type, file_size, kind, lat, lng;

  if (contentType.startsWith('multipart/form-data')) {
    const form = await request.formData();
    kind = String(form.get('kind') || '');
    if (!['pickup_photo','delivery_photo','signature','id_photo','other'].includes(kind))
      throw new BadRequestError('Invalid or missing "kind"');
    if (form.get('lat')) lat = Number(form.get('lat'));
    if (form.get('lng')) lng = Number(form.get('lng'));
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new BadRequestError('Missing "file" field');
    const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 10);
    if (file.size > MAX_MB * 1024 * 1024) throw new BadRequestError(`File too large (max ${MAX_MB}MB)`);
    mime_type = file.type || 'application/octet-stream';
    file_size = file.size;
    const buf = Buffer.from(await file.arrayBuffer());
    const saved = await saveBufferToStorage(buf, mime_type, mimeToExt(mime_type));
    file_url = saved.publicUrl;
  } else {
    const body = uploadProofSchema.parse(await readJson(request));
    ({ kind, file_url, mime_type, file_size, lat, lng } = body);
  }

  const { rows: [proof] } = await query(
    `INSERT INTO shipment_proofs (shipment_id, kind, file_url, file_size, mime_type, captured_by, lat, lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [s.id, kind, file_url, file_size || null, mime_type || null, user.id, lat || null, lng || null]
  );
  await logAudit({ request, actor: user, action: `shipment.proof.${kind}`, entityType: 'shipment', entityId: s.id });
  return created(proof);
});

exports.GET = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const { rows: shipRows } = await query(`SELECT customer_id, rider_id FROM shipments WHERE id=$1`, [params.id]);
  const s = shipRows[0];
  if (!s) throw new NotFoundError('Shipment not found');
  const authorized =
    (user.role === 'customer' && s.customer_id === user.id) ||
    (user.role === 'rider' && s.rider_id === user.id) ||
    user.role === 'admin' || user.role === 'dispatcher';
  if (!authorized) throw new ForbiddenError();
  const { rows } = await query(`SELECT * FROM shipment_proofs WHERE shipment_id=$1 ORDER BY captured_at ASC`, [params.id]);
  return ok(rows);
});
