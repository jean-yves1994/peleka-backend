/**
 * Google Sign-In: verify an ID token issued by Google.
 * Uses Google's tokeninfo endpoint (no extra deps).
 */
const { UnauthorizedError } = require('./errors');

function allowedAudiences() {
  const raw = process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') throw new UnauthorizedError('Missing Google id_token');
  const auds = allowedAudiences();
  if (auds.length === 0) throw new UnauthorizedError('Server is not configured for Google Sign-In (GOOGLE_CLIENT_IDS missing)');

  const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
  let payload;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`tokeninfo status ${res.status}`);
    payload = await res.json();
  } catch (err) {
    throw new UnauthorizedError('Could not verify Google token: ' + err.message);
  }

  if (payload.error || payload.error_description) {
    throw new UnauthorizedError('Google rejected the token: ' + (payload.error_description || payload.error));
  }
  if (!auds.includes(payload.aud)) throw new UnauthorizedError('Google token audience mismatch');
  if (!['https://accounts.google.com','accounts.google.com'].includes(payload.iss)) {
    throw new UnauthorizedError('Google token issuer mismatch');
  }
  if (Number(payload.exp) * 1000 < Date.now()) throw new UnauthorizedError('Google token expired');
  if (!payload.email) throw new UnauthorizedError('Google token has no email claim');

  return {
    sub: payload.sub,
    email: String(payload.email).toLowerCase(),
    email_verified: payload.email_verified === true || payload.email_verified === 'true',
    name: payload.name || payload.given_name || 'Google User',
    picture: payload.picture || null,
    aud: payload.aud, iss: payload.iss,
  };
}
module.exports = { verifyGoogleIdToken };
