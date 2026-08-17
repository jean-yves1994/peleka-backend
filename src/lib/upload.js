const crypto = require('crypto');
const { put } = require('@vercel/blob');
const { BadRequestError } = require('./errors');

const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 4);
const MAX_BYTES = MAX_MB * 1024 * 1024;

// Proofs are images only. Signature, ID photos, PDFs and arbitrary files are
// intentionally not supported in the current Peleka flow.
const ALLOWED = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

async function readFileFromRequest(request) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    throw new BadRequestError('Missing "file" field in multipart body');
  }

  const size = Number(file.size || 0);
  const mimeType = String(file.type || '').toLowerCase();

  if (!ALLOWED.has(mimeType)) {
    throw new BadRequestError(`Unsupported content type: ${mimeType || 'unknown'}`);
  }
  if (size <= 0) {
    throw new BadRequestError('Uploaded file is empty');
  }
  if (size > MAX_BYTES) {
    throw new BadRequestError(`File too large (max ${MAX_MB}MB)`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > MAX_BYTES) {
    throw new BadRequestError(`File too large (max ${MAX_MB}MB)`);
  }

  return {
    buffer,
    filename: file.name || 'proof',
    mimeType,
    size: buffer.length,
  };
}

async function saveBufferToStorage(buffer, mimeType, ext, pathname) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
  }
  if (!ALLOWED.has(String(mimeType || '').toLowerCase())) {
    throw new BadRequestError(`Unsupported content type: ${mimeType || 'unknown'}`);
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new BadRequestError('Uploaded file is empty');
  }
  if (buffer.length > MAX_BYTES) {
    throw new BadRequestError(`File too large (max ${MAX_MB}MB)`);
  }

  const finalExt = ext || mimeToExt(mimeType);
  if (!finalExt) throw new BadRequestError('Unsupported image type');

  const finalPath = pathname || `uploads/proofs/${crypto.randomUUID()}.${finalExt}`;

  return put(finalPath, buffer, {
    access: 'public',
    contentType: mimeType,
    addRandomSuffix: false,
  });
}

function mimeToExt(mime) {
  return {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  }[String(mime || '').toLowerCase()];
}

module.exports = {
  readFileFromRequest,
  saveBufferToStorage,
  mimeToExt,
  MAX_MB,
};
