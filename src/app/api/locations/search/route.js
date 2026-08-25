const { requireAuth } = require("@/lib/auth");
const { ok } = require("@/lib/response");
const { BadRequestError } = require("@/lib/errors");
const { withHandler } = require("@/lib/route-helpers");
const { query } = require("@/lib/db");
const { openStreetMapSearch } = require("@/lib/google");

exports.dynamic = "force-dynamic";

/**
 * GET /api/locations/search?q=...
 *
 * Location priority:
 *   1. Peleka's known_locations table (the 46 controlled locations).
 *   2. OpenStreetMap/Nominatim when the known-location search has no match.
 *
 * Known locations always return the database coordinates. This prevents a
 * customer selecting "Kimironko" and accidentally getting a similarly named
 * third-party place with different coordinates.
 */
exports.GET = withHandler(async (request) => {
  await requireAuth(request);

  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim();
  const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") || 8)));

  if (q.length < 2) {
    return ok([], { mode: "search", query: q });
  }

  const { rows: known } = await query(
    `SELECT id, name, district, sector, latitude, longitude, source
       FROM known_locations
      WHERE name ILIKE $1
         OR district ILIKE $1
         OR sector ILIKE $1
      ORDER BY
        CASE
          WHEN lower(name) = lower($2) THEN 1
          WHEN name ILIKE $3 THEN 2
          WHEN sector ILIKE $3 THEN 3
          WHEN name ILIKE $1 THEN 4
          WHEN sector ILIKE $1 THEN 5
          WHEN district ILIKE $1 THEN 6
          ELSE 7
        END,
        length(name), name
      LIMIT $4`,
    [`%${q}%`, q, `${q}%`, limit],
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
    source: "known",
  }));

  // If Peleka has a controlled match, use it as the authoritative result set.
  if (knownResults.length > 0) {
    return ok(knownResults, { mode: "known", query: q });
  }

  // External fallback for addresses that are not one of Peleka's 46 known
  // locations. Current coordinates are optional and only bias the search.
  const lat = url.searchParams.has("lat")
    ? Number(url.searchParams.get("lat"))
    : undefined;
  const lng = url.searchParams.has("lng")
    ? Number(url.searchParams.get("lng"))
    : undefined;

  if (
    (lat !== undefined && !Number.isFinite(lat)) ||
    (lng !== undefined && !Number.isFinite(lng))
  ) {
    throw new BadRequestError("Invalid latitude or longitude");
  }

  const places = await openStreetMapSearch(q, {
    latitude: lat,
    longitude: lng,
    radiusMeters: Number(url.searchParams.get("radius") || 10000),
  });

  return ok(
    places.slice(0, limit).map((p) => ({
      ...p,
      source: "external",
    })),
    { mode: "external", query: q },
  );
});
