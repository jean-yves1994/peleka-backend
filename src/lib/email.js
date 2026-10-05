const RESEND_API_URL = 'https://api.resend.com/emails';

function resetUrl(token) {
  const template =
    process.env.PASSWORD_RESET_URL ||
    'https://www.pelekaapp.com/reset-password?token={{token}}';
  return template.replace('{{token}}', encodeURIComponent(token));
}

async function sendPasswordResetEmail({ to, fullName, token }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.EMAIL_FROM || '').trim();

  if (!apiKey || !from) {
    return { ok: false, error: 'email_env_missing', detail: 'RESEND_API_KEY and EMAIL_FROM are required' };
  }

  const url = resetUrl(token);
  const safeName = String(fullName || 'there').replace(/[<>]/g, '');
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f6f8fb;padding:32px;color:#0b1f3a">
    <div style="max-width:560px;margin:auto;background:#fff;border-radius:20px;padding:32px">
      <h1 style="margin:0;color:#08295D">PELEKA<span style="color:#FF8508">.</span></h1>
      <h2 style="margin-top:28px">Reset your password</h2>
      <p>Hello ${safeName},</p>
      <p>We received a request to reset your Peleka password. This link expires in 60 minutes and can only be used once.</p>
      <p style="margin:28px 0"><a href="${url}" style="display:inline-block;background:#FF8508;color:#fff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:700">Reset password</a></p>
      <p style="font-size:13px;color:#64748B">If you did not request this, you can safely ignore this email.</p>
    </div></body></html>`;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: 'Reset your Peleka password', html }),
    });
    let detail = null;
    try { detail = await res.json(); } catch (_) {}
    if (!res.ok) {
      return { ok: false, status: res.status, error: detail?.message || detail?.name || 'email_send_failed', resendId: detail?.id || null };
    }
    return { ok: true, resendId: detail?.id || null };
  } catch (error) {
    return { ok: false, error: 'email_transport_failed', detail: error?.message || String(error) };
  }
}

module.exports = { sendPasswordResetEmail };
