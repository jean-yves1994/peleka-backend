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

function mapsApiKey() {
  return process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || '';
}

async function googlePlacesSearch(text, { latitude, longitude, radiusMeters = 10000 } = {}) {
  const key = mapsApiKey();
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is not configured');

  const body = { textQuery: text, languageCode: 'en' };
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    body.locationBias = {
      circle: {
        center: { latitude, longitude },
        radius: Math.min(Math.max(Number(radiusMeters) || 10000, 100), 50000),
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
          'places.types',
        ].join(','),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Google Places returned ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    return (data.places || []).map((p) => ({
      place_id: p.id || null,
      name: p.displayName?.text || '',
      address: p.formattedAddress || '',
      lat: p.location?.latitude ?? null,
      lng: p.location?.longitude ?? null,
      types: p.types || [],
    }));
  } finally {
    clearTimeout(timer);
  }
}

async function reverseGeocode(latitude, longitude) {
  const key = mapsApiKey();
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(latitude)},${encodeURIComponent(longitude)}&key=${encodeURIComponent(key)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Google Geocoding returned ${res.status}`);
    const data = await res.json();
    const result = data.results?.[0];
    if (!result) return null;
    return {
      address: result.formatted_address || '',
      place_id: result.place_id || null,
      lat: result.geometry?.location?.lat ?? latitude,
      lng: result.geometry?.location?.lng ?? longitude,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { verifyGoogleIdToken, googlePlacesSearch, reverseGeocode };
