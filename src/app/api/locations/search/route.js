const { requireAuth } = require("@/lib/auth");
const { ok } = require("@/lib/response");
const { BadRequestError } = require("@/lib/errors");
const { withHandler } = require("@/lib/route-helpers");
const { query } = require("@/lib/db");
const { openStreetMapSearch } = require("@/lib/google");

exports.dynamic = "force-dynamic";

/**
 * Search Peleka-controlled locations first, then Rwanda-restricted external
 * geocoding. Search results are location candidates; their coordinates remain
 * the authoritative coordinates sent to pricing.
 */
exports.GET = withHandler(async (request) => {
  await requireAuth(request);
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim();
  const limitRaw = Number(url.searchParams.get("limit") || 8);
  const limit = Number.isFinite(limitRaw) ? Math.min(10, Math.max(1, Math.floor(limitRaw))) : 8;

  if (q.length < 2) return ok([], { mode: "search", query: q });

  const lat = url.searchParams.has("lat") ? Number(url.searchParams.get("lat")) : undefined;
  const lng = url.searchParams.has("lng") ? Number(url.searchParams.get("lng")) : undefined;
  if ((lat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
      (lng !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
    throw new BadRequestError("Invalid latitude or longitude");
  }

  const { rows: known } = await query(
    `SELECT id, name, district, sector, latitude, longitude, source,
            aliases, location_type, accuracy_meters
       FROM known_locations
      WHERE is_active = TRUE
        AND country_code = 'RW'
        AND (
          name ILIKE $1
          OR district ILIKE $1
          OR sector ILIKE $1
          OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE $1)
        )
      ORDER BY
        CASE
          WHEN lower(name) = lower($2) THEN 1
          WHEN EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = lower($2)) THEN 2
          WHEN name ILIKE $3 THEN 3
          WHEN EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE $3) THEN 4
          WHEN sector ILIKE $3 THEN 5
          WHEN name ILIKE $1 THEN 6
          WHEN sector ILIKE $1 THEN 7
          WHEN district ILIKE $1 THEN 8
          ELSE 9
        END,
        length(name), name
      LIMIT $4`,
    [`%${q}%`, q, `${q}%`, limit],
  );

  if (known.length > 0) {
    return ok(known.map((p) => ({
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
    })), { mode: "known", query: q });
  }

  const places = await openStreetMapSearch(q, {
    latitude: lat,
    longitude: lng,
    radiusMeters: Number(url.searchParams.get("radius") || 10000),
  });

  return ok(places.slice(0, limit), { mode: "external", query: q });
});
