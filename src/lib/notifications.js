const { query } = require('./db');

async function createInAppNotification({ userId, title, body, data, channel = 'in_app' }) {
  const { rows } = await query(
    `INSERT INTO notifications (user_id, channel, title, body, data, sent_at)
     VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
    [userId, channel, title, body, data || {}]
  );
  return rows[0];
}
async function getUserDeviceTokens(userId) {
  const { rows } = await query(
    `SELECT token, platform FROM device_tokens WHERE user_id = $1 AND is_active = TRUE`, [userId]
  );
  return rows;
}
async function sendFcm(tokens, { title, body, data }) {
  if (!process.env.FCM_SERVER_KEY || tokens.length === 0) return { skipped: true };
  try {
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        Authorization: `key=${process.env.FCM_SERVER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        registration_ids: tokens,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.warn('[fcm] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}
async function notify({ userId, title, body, data }) {
  const inApp = await createInAppNotification({ userId, title, body, data });
  const tokens = await getUserDeviceTokens(userId);
  if (tokens.length > 0) await sendFcm(tokens.map(t => t.token), { title, body, data });
  return inApp;
}
module.exports = { notify, createInAppNotification };
