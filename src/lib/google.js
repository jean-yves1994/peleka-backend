/**
 * Google Sign-In: verify an ID token issued by Google.
 * Uses Google's tokeninfo endpoint (no extra deps).
 */
const { UnauthorizedError } = require("./errors");

function allowedAudiences() {
  const raw =
    process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || "";

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") {
    throw new UnauthorizedError("Missing Google id_token");
  }

  const auds = allowedAudiences();

  if (auds.length === 0) {
    throw new UnauthorizedError(
      "Server is not configured for Google Sign-In (GOOGLE_CLIENT_IDS missing)",
    );
  }

  const url =
    "https://oauth2.googleapis.com/tokeninfo?id_token=" +
    encodeURIComponent(idToken);

  let payload;

  try {
    const controller = new AbortController();

    const t = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
    });

    clearTimeout(t);

    if (!res.ok) {
      throw new Error(`tokeninfo status ${res.status}`);
    }

    payload = await res.json();
  } catch (err) {
    throw new UnauthorizedError(
      "Could not verify Google token: " + err.message,
    );
  }

  if (payload.error || payload.error_description) {
    throw new UnauthorizedError(
      "Google rejected the token: " +
        (payload.error_description || payload.error),
    );
  }

  if (!auds.includes(payload.aud)) {
    throw new UnauthorizedError("Google token audience mismatch");
  }

  if (
    !["https://accounts.google.com", "accounts.google.com"].includes(
      payload.iss,
    )
  ) {
    throw new UnauthorizedError("Google token issuer mismatch");
  }

  if (Number(payload.exp) * 1000 < Date.now()) {
    throw new UnauthorizedError("Google token expired");
  }

  if (!payload.email) {
    throw new UnauthorizedError("Google token has no email claim");
  }

  return {
    sub: payload.sub,
    email: String(payload.email).toLowerCase(),
    email_verified:
      payload.email_verified === true || payload.email_verified === "true",
    name: payload.name || payload.given_name || "Google User",
    picture: payload.picture || null,
    aud: payload.aud,
    iss: payload.iss,
  };
}

/**
 * OpenStreetMap place search using Nominatim.
 */
async function openStreetMapSearch(
  text,
  { latitude, longitude, radiusMeters = 10000 } = {},
) {
  const params = new URLSearchParams({
    q: text,
    format: "jsonv2",
    addressdetails: "1",
    limit: "10",
  });

  /*
    Nominatim does not use radius directly.
    We bias results using viewbox when coordinates are available.
  */
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const radius =
      Math.min(Math.max(Number(radiusMeters) || 10000, 1000), 50000) / 111000;

    params.set(
      "viewbox",
      [
        longitude - radius,
        latitude + radius,
        longitude + radius,
        latitude - radius,
      ].join(","),
    );

    params.set("bounded", "0");
  }

  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`,
      {
        signal: controller.signal,
        headers: {
          "User-Agent": "Peleka Delivery Platform",
        },
      },
    );

    if (!res.ok) {
      throw new Error(`OpenStreetMap search failed: ${res.status}`);
    }

    const data = await res.json();

    return data.map((p) => ({
      place_id: String(p.place_id),
      name: p.display_name?.split(",")?.slice(0, 2)?.join(",") || "",
      address: p.display_name || "",
      lat: Number(p.lat),
      lng: Number(p.lon),
      types: p.type ? [p.type] : [],
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenStreetMap reverse geocoding using Nominatim.
 */
async function openStreetMapReverse(latitude, longitude) {
  const params = new URLSearchParams({
    lat: latitude,
    lon: longitude,
    format: "jsonv2",
    addressdetails: "1",
  });

  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?${params}`,
      {
        signal: controller.signal,
        headers: {
          "User-Agent": "Peleka Delivery Platform",
        },
      },
    );

    if (!res.ok) {
      throw new Error(`OpenStreetMap reverse failed: ${res.status}`);
    }

    const data = await res.json();

    if (!data || !data.display_name) {
      return null;
    }

    return {
      address: data.display_name,
      place_id: String(data.place_id || ""),
      lat: Number(data.lat) || latitude,
      lng: Number(data.lon) || longitude,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  verifyGoogleIdToken,
  openStreetMapSearch,
  openStreetMapReverse,
};
