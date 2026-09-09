const { requireAuth } = require("@/lib/auth");
const { ok } = require("@/lib/response");
const { BadRequestError } = require("@/lib/errors");
const { withHandler } = require("@/lib/route-helpers");
const { query } = require("@/lib/db");
const { openStreetMapSearch } = require("@/lib/google");

exports.dynamic = "force-dynamic";

function normalizeSearch(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(st|str)\.?\b/g, "street")
    .replace(/\b(rd|rd\.)\b/g, "road")
    .replace(/\b(ave|av)\.?\b/g, "avenue")
    .replace(/\b(kg|kn|kk|rn)\s*[-.]?\s*(\d+)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Search Peleka-controlled locations and external Rwanda addresses together.
 * Search results are candidates only. A shipment should use coordinates that
 * the customer has explicitly confirmed, preferably with a map pin.
 */
exports.GET = withHandler(async (request) => {
  await requireAuth(request);
  const url = new URL(request.url);
  const rawQuery = String(url.searchParams.get("q") || "").trim();
  const q = normalizeSearch(rawQuery);
  const limitRaw = Number(url.searchParams.get("limit") || 8);
  const limit = Number.isFinite(limitRaw) ? Math.min(10, Math.max(1, Math.floor(limitRaw))) : 8;

  if (q.length < 2) return ok([], { mode: "search", query: rawQuery });

  const lat = url.searchParams.has("lat") ? Number(url.searchParams.get("lat")) : undefined;
  const lng = url.searchParams.has("lng") ? Number(url.searchParams.get("lng")) : undefined;
  if ((lat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
      (lng !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
    throw new BadRequestError("Invalid latitude or longitude");
  }

  const like = `%${q}%`;
  const prefix = `${q}%`;
  const { rows: known } = await query(
    `SELECT id, name, district, sector, latitude, longitude, source,
            aliases, location_type, accuracy_meters
       FROM known_locations
      WHERE is_active = TRUE
        AND country_code = 'RW'
        AND (
          lower(name) ILIKE $1
          OR lower(district) ILIKE $1
          OR lower(sector) ILIKE $1
          OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) ILIKE $1)
        )
      ORDER BY
        CASE
          WHEN lower(name) = $2 THEN 1
          WHEN EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = $2) THEN 2
          WHEN lower(name) ILIKE $3 THEN 3
          WHEN EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) ILIKE $3) THEN 4
          WHEN lower(sector) ILIKE $3 THEN 5
          WHEN lower(name) ILIKE $1 THEN 6
          WHEN lower(sector) ILIKE $1 THEN 7
          WHEN lower(district) ILIKE $1 THEN 8
          ELSE 9
        END,
        length(name), name
      LIMIT 10`,
    [like, q, prefix],
  );

  const knownResults = known.map((p) => ({
    place_id: `known:${p.id}`,
    id: p.id,
    name: p.name,
    address: [p.name, p.sector, p.district].filter(Boolean).join(", "),
    city: p.district || "",
    district: p.district || "",
    sector: p.sector || "",
    lat: Number(p.latitude),
    lng: Number(p.longitude),
    accuracy_meters: p.accuracy_meters == null ? null : Number(p.accuracy_meters),
    location_type: p.location_type || "landmark",
    source: "known",
    provider: "peleka",
    confidence: 1,
    verification_required: false,
    normalized_query: q,
  }));

  let externalResults = [];
  try {
    externalResults = await openStreetMapSearch(rawQuery, {
      latitude: lat,
      longitude: lng,
      radiusMeters: Number(url.searchParams.get("radius") || 10000),
    });
  } catch {
    // Controlled Peleka results remain usable when external geocoding is unavailable.
    externalResults = [];
  }

  const seen = new Set(knownResults.map((p) => `${p.lat.toFixed(6)}:${p.lng.toFixed(6)}`));
  const mergedExternal = externalResults.filter((p) => {
    const key = `${Number(p.lat).toFixed(6)}:${Number(p.lng).toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return ok([...knownResults, ...mergedExternal].slice(0, limit), {
    mode: knownResults.length && mergedExternal.length ? "combined" : knownResults.length ? "known" : "external",
    query: rawQuery,
    normalized_query: q,
  });
});
