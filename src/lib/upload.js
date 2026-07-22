const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { BadRequestError } = require('./errors');

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const PUBLIC_BASE = process.env.PUBLIC_UPLOAD_BASE_URL || 'http://localhost:3000/uploads';
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 10);
const ALLOWED = new Set(['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif','application/pdf']);

async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }

async function readFileFromRequest(request) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new BadRequestError('Missing "file" field in multipart body');
  const size = file.size;
  const mimeType = file.type || 'application/octet-stream';
  if (size > MAX_MB * 1024 * 1024) throw new BadRequestError(`File too large (max ${MAX_MB}MB)`);
  if (!ALLOWED.has(mimeType)) throw new BadRequestError(`Unsupported content type: ${mimeType}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  return { buffer, filename: file.name || 'upload.bin', mimeType, size };
}

async function saveBufferToStorage(buffer, mimeType, ext) {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const subdir = path.join(UPLOAD_DIR, yyyy, mm);
  await ensureDir(subdir);
  const id = crypto.randomBytes(12).toString('hex');
  const finalExt = ext || mimeToExt(mimeType) || 'bin';
  const filePath = path.join(subdir, `${id}.${finalExt}`);
  await fs.writeFile(filePath, buffer);
  return { publicUrl: `${PUBLIC_BASE}/${yyyy}/${mm}/${id}.${finalExt}`, filePath };
}

function mimeToExt(mime) {
  return { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp',
    'image/heic':'heic','image/heif':'heif','application/pdf':'pdf' }[mime];
}
module.exports = { readFileFromRequest, saveBufferToStorage, mimeToExt, UPLOAD_DIR };
