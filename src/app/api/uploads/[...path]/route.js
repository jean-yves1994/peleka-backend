exports.dynamic = 'force-dynamic';

// Legacy local-filesystem uploads are disabled. Peleka proof images are stored
// in Vercel Blob and their public Blob URLs are returned by the proof API.
exports.GET = async () => new Response('Legacy local upload storage is disabled', { status: 410 });
