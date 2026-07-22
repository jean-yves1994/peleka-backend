const fs = require('fs/promises');
const path = require('path');
const { UPLOAD_DIR } = require('@/lib/upload');

exports.dynamic = 'force-dynamic';
exports.GET = async (_request, { params }) => {
  const parts = params.path || [];
  if (parts.some(p => p.includes('..') || p.includes('\\') || p.includes('/'))) {
    return new Response('Bad Request', { status: 400 });
  }
  const filePath = path.join(UPLOAD_DIR, ...parts);
  try {
    const buf = await fs.readFile(filePath);
    const ext = (parts[parts.length - 1] || '').split('.').pop().toLowerCase();
    const mime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp',
      heic:'image/heic', heif:'image/heif', pdf:'application/pdf' }[ext] || 'application/octet-stream';
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  } catch { return new Response('Not Found', { status: 404 }); }
};
