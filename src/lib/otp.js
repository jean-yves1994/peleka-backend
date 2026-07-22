const crypto = require('crypto');
const { query } = require('./db');
const { BadRequestError, TooManyRequestsError } = require('./errors');

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 5);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const OTP_RESEND_COOLDOWN_SEC = Number(process.env.OTP_RESEND_COOLDOWN_SEC || 60);

function generateCode() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}
function hashCode(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
function normalizePhone(phone) {
  if (!phone) return null;
  return String(phone).replace(/[\s\-()]/g, '').trim();
}

async function issueOtp({ phone, purpose = 'login', ip, userAgent }) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new BadRequestError('phone is required');

  const cd = await query(
    `SELECT created_at FROM phone_otps
      WHERE phone = $1 AND consumed_at IS NULL AND expires_at > NOW()
        AND created_at > NOW() - ($2::int * INTERVAL '1 second')
      ORDER BY created_at DESC LIMIT 1`,
    [normalized, OTP_RESEND_COOLDOWN_SEC]
  );
  if (cd.rowCount > 0) {
    const nextAt = new Date(cd.rows[0].created_at).getTime() + OTP_RESEND_COOLDOWN_SEC * 1000;
    const waitSec = Math.max(1, Math.ceil((nextAt - Date.now()) / 1000));
    throw new TooManyRequestsError(`Please wait ${waitSec}s before requesting a new code`);
  }

  const code = generateCode();
  const expires_at = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);
  const { rows: [row] } = await query(
    `INSERT INTO phone_otps (phone, code_hash, purpose, max_attempts, expires_at, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, expires_at`,
    [normalized, hashCode(code), purpose, OTP_MAX_ATTEMPTS, expires_at, ip || null, userAgent || null]
  );
  return { id: row.id, expires_at: row.expires_at, code, phone: normalized };
}

async function verifyOtp({ phone, code }) {
  const normalized = normalizePhone(phone);
  if (!normalized || !code) throw new BadRequestError('phone and code are required');

  const { rows: [otp] } = await query(
    `SELECT * FROM phone_otps
      WHERE phone = $1 AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [normalized]
  );
  if (!otp) throw new BadRequestError('No active code for this phone');
  if (new Date(otp.expires_at) < new Date()) throw new BadRequestError('Code expired');
  if (otp.attempts >= otp.max_attempts) throw new BadRequestError('Too many attempts. Request a new code.');

  const supplied = hashCode(code);
  if (supplied !== otp.code_hash) {
    await query(`UPDATE phone_otps SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
    throw new BadRequestError('Incorrect code');
  }
  await query(`UPDATE phone_otps SET consumed_at = NOW() WHERE id = $1`, [otp.id]);
  return { phone: normalized, purpose: otp.purpose, verified_at: new Date() };
}
module.exports = { issueOtp, verifyOtp, normalizePhone, OTP_TTL_MINUTES };
