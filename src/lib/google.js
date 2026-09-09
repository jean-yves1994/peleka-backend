/**
 * Google Sign-In and OpenStreetMap geocoding helpers.
 */
const { UnauthorizedError } = require("./errors");

function allowedAudiences() {
  const raw = process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") throw new UnauthorizedError("Missing Google id_token");
  const auds = allowedAudiences();
  if (auds.length === 0) throw new UnauthorizedError("Server is not configured for Google Sign-In (GOOGLE_CLIENT_IDS missing)");
  const url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  let payload;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`tokeninfo status ${res.status}`);
    payload = await res.json();
  } catch (err) {
    throw new UnauthorizedError("Could not verify Google token: " + err.message);
  }
  if (payload.error || payload.error_description) throw new UnauthorizedError("Google rejected the token: " + (payload.error_description || payload.error));
  if (!auds.includes(payload.aud)) throw new UnauthorizedError("Google token audience mismatch");
  if (!["https://accounts.google.com", "accounts.google.com"].includes(payload.iss)) throw new UnauthorizedError("Google token issuer mismatch");
  if (Number(payload.exp) * 1000 < Date.now()) throw new UnauthorizedError("Google token expired");
  if (!payload.email) throw new UnauthorizedError("Google token has no email claim");
  return {
    sub: payload.sub,
    email: String(payload.email).toLowerCase(),
    email_verified: payload.email_verified === true || payload.email_verified === "true",
    name: payload.name || payload.given_name || "Google User",
    picture: payload.picture || null,
    aud: payload.aud,
    iss: payload.iss,
  };
}

function normalizeRwandaAddress(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[–—]/g, "-")
    .replace(/\b(st|str)\.?\b/gi, "street")
    .replace(/\b(rd|rd\.)\b/gi, "road")
    .replace(/\b(ave|av)\.?\b/gi, "avenue")
    .replace(/\bkg\s*[-.]?\s*(\d+)/gi, "KG $1")
    .replace(/\bkn\s*[-.]?\s*(\d+)/gi, "KN $1")
    .replace(/\bkk\s*[-.]?\s*(\d+)/gi, "KK $1")
    .replace(/\brn\s*[-.]?\s*(\d+)/gi, "RN $1")
    .replace(/\s+/g, " ")
    .trim();
}

async function openStreetMapSearch(text, { latitude, longitude, radiusMeters = 10000 } = {}) {
  const normalized = normalizeRwandaAddress(text);
  const params = new URLSearchParams({
    q: `${normalized}, Kigali, Rwanda`,
    format: "jsonv2",
    addressdetails: "1",
    limit: "10",
    countrycodes: "rw",
    dedupe: "1",
  });

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const radius = Math.min(Math.max(Number(radiusMeters) || 10000, 1000), 50000) / 111000;
    params.set("viewbox", [longitude - radius, latitude + radius, longitude + radius, latitude - radius].join(","));
    params.set("bounded", "0");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      signal: controller.signal,
      headers: { "User-Agent": process.env.GEOCODING_USER_AGENT || "Peleka Delivery Platform" },
    });
    if (!res.ok) throw new Error(`OpenStreetMap search failed: ${res.status}`);
    const data = await res.json();
    return data.map((p) => ({
      place_id: String(p.place_id),
      name: p.display_name?.split(",")?.slice(0, 2)?.join(",") || normalized,
      address: p.display_name || normalized,
      city: p.address?.city || p.address?.town || p.address?.municipality || p.address?.district || "",
      district: p.address?.district || "",
      sector: p.address?.suburb || p.address?.quarter || "",
      lat: Number(p.lat),
      lng: Number(p.lon),
      types: p.type ? [p.type] : [],
      source: "external",
      provider: "nominatim",
      confidence: Number.isFinite(Number(p.importance)) ? Math.min(1, Math.max(0, Number(p.importance))) : null,
      verification_required: true,
      normalized_query: normalized,
    }));
  } finally {
    clearTimeout(timer);
  }
}

async function openStreetMapReverse(latitude, longitude) {
  const params = new URLSearchParams({ lat: latitude, lon: longitude, format: "jsonv2", addressdetails: "1" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
      signal: controller.signal,
      headers: { "User-Agent": process.env.GEOCODING_USER_AGENT || "Peleka Delivery Platform" },
    });
    if (!res.ok) throw new Error(`OpenStreetMap reverse failed: ${res.status}`);
    const data = await res.json();
    if (!data || !data.display_name) return null;
    return {
      address: data.display_name,
      place_id: String(data.place_id || ""),
      lat: latitude,
      lng: longitude,
      city: data.address?.city || data.address?.town || data.address?.municipality || data.address?.district || "",
      district: data.address?.district || "",
      sector: data.address?.suburb || data.address?.quarter || "",
      source: "external",
      provider: "nominatim",
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { verifyGoogleIdToken, openStreetMapSearch, openStreetMapReverse, normalizeRwandaAddress };
