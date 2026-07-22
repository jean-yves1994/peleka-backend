const PROVIDER = (process.env.SMS_PROVIDER || '').toLowerCase();

async function sendTwilio(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return { ok: false, error: 'twilio_env_missing' };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const form = new URLSearchParams({ To: to, From: from, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  return { ok: res.ok, status: res.status };
}
async function sendAfricasTalking(to, body) {
  const username = process.env.AT_USERNAME, apiKey = process.env.AT_API_KEY, from = process.env.AT_FROM || undefined;
  if (!username || !apiKey) return { ok: false, error: 'at_env_missing' };
  const form = new URLSearchParams({ username, to, message: body });
  if (from) form.set('from', from);
  const res = await fetch('https://api.africastalking.com/version1/messaging', {
    method: 'POST',
    headers: { apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form,
  });
  return { ok: res.ok, status: res.status };
}
async function sendSms(to, body) {
  try {
    if (PROVIDER === 'twilio') return await sendTwilio(to, body);
    if (PROVIDER === 'at') return await sendAfricasTalking(to, body);
    console.log(`[sms:dev] to=${to}  body="${body}"`);
    return { ok: true, delivered: false, dev: true };
  } catch (err) {
    console.warn('[sms] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}
module.exports = { sendSms };
