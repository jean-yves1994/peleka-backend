const { requireAuth } = require('@/lib/auth');
const { readFileFromRequest, saveBufferToStorage, mimeToExt } = require('@/lib/upload');
const { created } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
exports.POST = withHandler(async (request) => {
  await requireAuth(request);
  const { buffer, mimeType, size } = await readFileFromRequest(request);
  const saved = await saveBufferToStorage(buffer, mimeType, mimeToExt(mimeType));
  return created({ url: saved.publicUrl, mime_type: mimeType, size });
});
