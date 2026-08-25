const { requireAuth } = require("@/lib/auth");
const { ok } = require("@/lib/response");
const { BadRequestError } = require("@/lib/errors");
const { withHandler } = require("@/lib/route-helpers");
const { query } = require("@/lib/db");
const { openStreetMapReverse } = require("@/lib/google");

exports.dynamic = "force-dynamic";

/**
 * Reverse geocoding for "Use my current location".
 *
 * The browser's exact GPS coordinates are preserved. We only use the nearest
 * known Peleka location to improve the displayed label; we do NOT replace the
 * GPS coordinates with the nearest known location because that would distort
 * the final road-distance calculation.
 */
exports.GET = withHandler(async (request) => {
  await requireAuth(request);

  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new BadRequestError("Invalid latitude");
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new BadRequestError("Invalid longitude");
  }

  const [reverse, nearest] = await Promise.all([
    openStreetMapReverse(lat, lng),
    query(
      `SELECT id, name, district, sector, latitude, longitude,
              (
                6371 * acos(
                  LEAST(1, GREATEST(-1,
                    cos(radians($1)) * cos(radians(latitude)) *
                    cos(radians(longitude) - radians($2)) +
                    sin(radians($1)) * sin(radians(latitude))
                  ))
                )
              ) AS distance_km
         FROM known_locations
        ORDER BY distance_km ASC
        LIMIT 1`,
      [lat, lng],
    ),
  ]);

  const closest = nearest.rows[0] || null;
  const address = reverse?.address || reverse?.display_name || "Current location";

  return ok({
    ...(reverse || {}),
    address,
    lat,
    lng,
    source: "gps",
    nearest_known_location: closest
      ? {
          id: closest.id,
          name: closest.name,
          district: closest.district,
          sector: closest.sector,
          distance_km: Number(closest.distance_km),
        }
      : null,
  });
});
