const { query } = require('./db');
const { getClientIp, getUserAgent } = require('./middleware');

async function logAudit({ request, actor, action, entityType, entityId, data }) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, ip_address, user_agent, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [actor?.id || null, actor?.role || null, action, entityType || null, entityId || null,
       request ? getClientIp(request) : null, request ? getUserAgent(request) : null, data || {}]
    );
  } catch (err) {
    console.warn('[audit] insert failed:', err.message);
  }
}
module.exports = { logAudit };
