/**
 * Firebase ID token verifier (FIXED).
 *
 * Verifies an ID token issued by Firebase Phone Auth against Google's
 * public keys, then checks audience (your project id) and issuer.
 *
 * WHY THE PREVIOUS VERSION FAILED:
 *   It pointed jwks-rsa at the x509 endpoint
 *     https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
 *   That endpoint returns { "<kid>": "-----BEGIN CERTIFICATE-----..." } — a
 *   map of PEM certs, NOT a JWKS. jwks-rsa expects a { "keys": [ ... ] }
 *   document, so it reported "The JWKS does not contain any keys".
 *
 * THIS VERSION verifies against the x509 certs directly (no jwks-rsa needed),
 * which is exactly how Firebase documents server-side verification. It caches
 * the certs and refreshes them when a token's `kid` isn't found.
 *
 * Configure with FIREBASE_PROJECT_ID in .env.local.
 */
const jwt = require("jsonwebtoken");
const { UnauthorizedError } = require("./errors");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

// Google's public x509 certs for Firebase secure tokens (kid -> PEM cert).
const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let _certs = null; // { kid: pem }
let _certsFetchedAt = 0; // epoch ms

async function fetchCerts(force = false) {
  const now = Date.now();
  // Refresh at most every 60s unless forced (or first time).
  if (!force && _certs && now - _certsFetchedAt < 60_000) return _certs;
  const res = await fetch(CERT_URL);
  if (!res.ok)
    throw new Error(`Failed to fetch Firebase certs: HTTP ${res.status}`);
  _certs = await res.json();
  _certsFetchedAt = now;
  return _certs;
}

/**
 * Verify a Firebase ID token.
 * Resolves to { uid, phone, email, email_verified, name, picture, firebase }.
 */
async function verifyFirebaseIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") {
    throw new UnauthorizedError("Missing Firebase id_token");
  }
  if (!PROJECT_ID) {
    throw new UnauthorizedError(
      "Server not configured for Firebase (FIREBASE_PROJECT_ID missing)",
    );
  }

  // Decode header to get the key id (kid) without verifying yet.
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw new UnauthorizedError("Invalid Firebase token: missing kid header");
  }
  const kid = decoded.header.kid;

  // Look up the signing cert; refresh once if we don't recognize the kid.
  let certs = await fetchCerts();
  let pem = certs[kid];
  if (!pem) {
    certs = await fetchCerts(true);
    pem = certs[kid];
  }
  if (!pem) {
    throw new UnauthorizedError(
      "Invalid Firebase token: signing key not found",
    );
  }

  let payload;
  try {
    payload = jwt.verify(idToken, pem, {
      algorithms: ["RS256"],
      audience: PROJECT_ID,
      issuer: `https://securetoken.google.com/${PROJECT_ID}`,
    });
  } catch (err) {
    throw new UnauthorizedError("Invalid Firebase token: " + err.message);
  }

  // Firebase-specific claim sanity checks.
  if (!payload.sub) {
    throw new UnauthorizedError("Invalid Firebase token: missing sub");
  }
  if (
    payload.auth_time &&
    Number(payload.auth_time) > Math.floor(Date.now() / 1000) + 60
  ) {
    throw new UnauthorizedError(
      "Invalid Firebase token: auth_time in the future",
    );
  }
  if (!payload.phone_number && !payload.email) {
    throw new UnauthorizedError("Firebase token has no phone_number or email");
  }

  return {
    uid: payload.user_id || payload.sub,
    phone: payload.phone_number || null,
    email: payload.email ? String(payload.email).toLowerCase() : null,
    email_verified: payload.email_verified === true,
    name: payload.name || null,
    picture: payload.picture || null,
    firebase: payload.firebase || {},
  };
}

module.exports = { verifyFirebaseIdToken };
