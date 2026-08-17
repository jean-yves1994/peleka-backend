const crypto = require('crypto');
const { del } = require('@vercel/blob');
const { query } = require('@/lib/db');
const { requireAuth } = require('@/lib/auth');
const { saveBufferToStorage, mimeToExt, MAX_MB } = require('@/lib/upload');
const { created, ok } = require('@/lib/response');
const { NotFoundError, ForbiddenError, BadRequestError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

const ALLOWED_KINDS = new Set(['pickup_photo', 'delivery_photo']);
const PICKUP_STATUSES = new Set(['assigned', 'rider_en_route_to_pickup']);
const DELIVERY_STATUSES = new Set(['picked_up', 'in_transit', 'out_for_delivery']);

exports.POST = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const { rows } = await query(
    `SELECT id, rider_id, customer_id, status FROM shipments WHERE id=$1`,
    [params.id]
  );
  const s = rows[0];
  if (!s) throw new NotFoundError('Shipment not found');

  const isRider = user.role === 'rider' && s.rider_id === user.id;
  const isAdmin = user.role === 'admin' || user.role === 'dispatcher';
  if (!isRider && !isAdmin) {
    throw new ForbiddenError('Only the assigned rider or an admin can upload proofs');
  }

  const contentType = request.headers.get('content-type') || '';
  let file_url;
  let mime_type;
  let file_size;
  let kind;
  let lat;
  let lng;
  let blobUrl = null;

  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    const form = await request.formData();
    kind = String(form.get('kind') || '');

    if (!ALLOWED_KINDS.has(kind)) {
      throw new BadRequestError(
        'Invalid or missing "kind". Allowed values: pickup_photo, delivery_photo'
      );
    }

    if (kind === 'pickup_photo' && !PICKUP_STATUSES.has(s.status)) {
      throw new BadRequestError(
        `Pickup proof cannot be uploaded while shipment is in status "${s.status}"`
      );
    }
    if (kind === 'delivery_photo' && !DELIVERY_STATUSES.has(s.status)) {
      throw new BadRequestError(
        `Delivery proof cannot be uploaded while shipment is in status "${s.status}"`
      );
    }

    const latValue = form.get('lat');
    const lngValue = form.get('lng');
    if (latValue !== null && latValue !== '') lat = Number(latValue);
    if (lngValue !== null && lngValue !== '') lng = Number(lngValue);

    if (lat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
      throw new BadRequestError('Invalid latitude');
    }
    if (lng !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180)) {
      throw new BadRequestError('Invalid longitude');
    }

    const file = form.get('file');
    if (!file || typeof file === 'string') {
      throw new BadRequestError('Missing "file" field');
    }

    const size = Number(file.size || 0);
    if (size <= 0) throw new BadRequestError('Uploaded file is empty');
    if (size > MAX_MB * 1024 * 1024) {
      throw new BadRequestError(`File too large (max ${MAX_MB}MB)`);
    }

    mime_type = String(file.type || '').toLowerCase();
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_MB * 1024 * 1024) {
      throw new BadRequestError(`File too large (max ${MAX_MB}MB)`);
    }

    const ext = mimeToExt(mime_type);
    if (!ext) throw new BadRequestError(`Unsupported content type: ${mime_type || 'unknown'}`);

    const pathname = `shipments/${s.id}/proofs/${kind}/${crypto.randomUUID()}.${ext}`;
    const blob = await saveBufferToStorage(buf, mime_type, ext, pathname);
    blobUrl = blob.url;
    file_url = blob.url;
    file_size = buf.length;
  } else {
    // JSON proof creation is deliberately rejected. New proofs must be real
    // image uploads through Vercel Blob; clients cannot inject arbitrary URLs.
    throw new BadRequestError('Proofs must be uploaded as multipart/form-data');
  }

  try {
    const { rows: [proof] } = await query(
      `INSERT INTO shipment_proofs
        (shipment_id, kind, file_url, file_size, mime_type, captured_by, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [s.id, kind, file_url, file_size, mime_type, user.id, lat ?? null, lng ?? null]
    );

    await logAudit({
      request,
      actor: user,
      action: `shipment.proof.${kind}`,
      entityType: 'shipment',
      entityId: s.id,
    });

    return created(proof);
  } catch (error) {
    // Avoid leaving an orphaned Blob when the DB insert fails.
    if (blobUrl) {
      try { await del(blobUrl); } catch (_) {}
    }
    throw error;
  }
});

exports.GET = withHandler(async (request, { params }) => {
  const user = await requireAuth(request);
  const { rows: shipRows } = await query(
    `SELECT customer_id, rider_id FROM shipments WHERE id=$1`,
    [params.id]
  );
  const s = shipRows[0];
  if (!s) throw new NotFoundError('Shipment not found');

  const authorized =
    (user.role === 'customer' && s.customer_id === user.id) ||
    (user.role === 'rider' && s.rider_id === user.id) ||
    user.role === 'admin' || user.role === 'dispatcher';
  if (!authorized) throw new ForbiddenError();

  const { rows } = await query(
    `SELECT * FROM shipment_proofs
     WHERE shipment_id=$1
       AND kind IN ('pickup_photo','delivery_photo')
     ORDER BY captured_at ASC`,
    [params.id]
  );
  return ok(rows);
});
