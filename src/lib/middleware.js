const { BadRequestError, TooManyRequestsError } = require('./errors');

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    if (text.length > 2 * 1024 * 1024) throw new BadRequestError('Request body too large');
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError('Invalid JSON body');
  }
}

function parseListParams(request, defaults = {}) {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || String(defaults.pageSize || 20), 10)));
  const q = (url.searchParams.get('q') || '').trim();
  const sort = url.searchParams.get('sort') || defaults.sort || 'created_at.desc';
  const [sortCol, sortDirRaw] = sort.split('.');
  const sortDir = (sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return { page, pageSize, offset: (page - 1) * pageSize, q, sortCol, sortDir, url };
}

function getClientIp(request) {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip') || null;
}
function getUserAgent(request) { return request.headers.get('user-agent') || null; }

const g = globalThis;
if (!g.__pelekaRateBuckets) g.__pelekaRateBuckets = new Map();
const buckets = g.__pelekaRateBuckets;

function rateLimit(key, { windowMs, max } = {}) {
  const win = windowMs || Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
  const lim = max || Number(process.env.RATE_LIMIT_MAX || 120);
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) { buckets.set(key, { count: 1, resetAt: now + win }); return; }
  b.count += 1;
  if (b.count > lim) {
    const retryAfter = Math.ceil((b.resetAt - now) / 1000);
    throw new TooManyRequestsError(`Too many requests. Retry in ${retryAfter}s`);
  }
}

module.exports = { readJson, parseListParams, rateLimit, getClientIp, getUserAgent };
