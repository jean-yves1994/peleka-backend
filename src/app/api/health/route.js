const { query } = require('@/lib/db');
const { ok, fail } = require('@/lib/response');
exports.dynamic = 'force-dynamic';
exports.GET = async () => {
  try {
    const r = await query('SELECT 1 AS ok, NOW() AS now');
    return ok({ status: 'healthy', db: r.rows[0].ok === 1, now: r.rows[0].now });
  } catch (err) {
    return fail(503, 'DB_UNREACHABLE', 'Database is not reachable', { message: err.message });
  }
};
