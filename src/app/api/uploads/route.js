/**
 * POST /api/uploads
 *
 * Stores a file in Vercel Blob and returns its public URL. Replaces the old
 * local-disk implementation, which silently lost files on Vercel because the
 * serverless filesystem is ephemeral — proof photos vanished between requests.
 *
 * Server upload (file → this function → Blob). Simple, no token handshake.
 * The tradeoff: a Vercel-hosted function caps the request body at 4.5 MB, so
 * the rider app compresses photos before sending. We enforce the ceiling here
 * too and return a clear error rather than a truncated upload.
 *
 * Auth: any signed-in user. Riders post proof photos; customers post
 * complaint attachments.
 *
 * Env:
 *   BLOB_READ_WRITE_TOKEN   auto-added when you create the Blob store
 *                           (or use OIDC by connecting the store to the project)
 */
const { put } = require('@vercel/blob');
const crypto = require('crypto');
const { requireAuth } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { BadRequestError, AppError } = require('@/lib/errors');
const { withHandler } = require('@/lib/route-helpers');
const { logAudit } = require('@/lib/audit');

exports.dynamic = 'force-dynamic';

// Vercel caps serverless request bodies at 4.5 MB. Stay under it.
const MAX_BYTES = 4 * 1024 * 1024; // 4 MB

const ALLOWED = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
]);

const EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);

  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
    throw new AppError(
      'File storage is not configured (BLOB_READ_WRITE_TOKEN missing)',
      500,
      'STORAGE_NOT_CONFIGURED',
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch (_) {
    throw new BadRequestError('Expected multipart/form-data with a "file" field');
  }

  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new BadRequestError('No file provided');
  }

  const contentType = (file.type || 'application/octet-stream').toLowerCase();
  if (!ALLOWED.has(contentType)) {
    throw new BadRequestError(
      `Unsupported file type "${contentType}". Allowed: JPEG, PNG, WebP, HEIC, PDF.`,
    );
  }

  const size = Number(file.size || 0);
  if (size > MAX_BYTES) {
    throw new BadRequestError(
      `File is ${(size / 1024 / 1024).toFixed(1)} MB. Maximum is 4 MB — ` +
        'please retake the photo at a lower quality.',
    );
  }
  if (size === 0) throw new BadRequestError('File is empty');

  // Foldered by purpose + date so the store stays browsable, and suffixed with
  // random bytes so two riders uploading at once can never collide.
  const purpose = String(form.get('purpose') || 'proof')
    .replace(/[^a-z0-9_-]/gi, '')
    .slice(0, 24) || 'proof';
  const day = new Date().toISOString().slice(0, 10);
  const ext = EXT[contentType] || 'bin';
  const rand = crypto.randomBytes(8).toString('hex');
  const pathname = `${purpose}/${day}/${user.id}-${Date.now()}-${rand}.${ext}`;

  let blob;
  try {
    blob = await put(pathname, file, {
      access: 'public',
      contentType,
      // We already made the name unique; keep the URL predictable.
      addRandomSuffix: false,
    });
  } catch (e) {
    throw new AppError(
      'Upload failed: ' + (e.message || 'storage error'),
      502,
      'STORAGE_UPLOAD_FAILED',
    );
  }

  await logAudit({
    request,
    actor: user,
    action: 'upload.created',
    entityType: 'upload',
    entityId: null,
    data: { pathname, size, content_type: contentType, purpose },
  });

  // Shape matches what the apps already expect from the old endpoint.
  return ok({
    url: blob.url,
    file_url: blob.url,
    download_url: blob.downloadUrl || blob.url,
    pathname: blob.pathname,
    mime_type: contentType,
    file_size: size,
  });
});
