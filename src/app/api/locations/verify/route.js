const { requireAuth } = require("@/lib/auth");
const { ok } = require("@/lib/response");
const { BadRequestError } = require("@/lib/errors");
const { withHandler } = require("@/lib/route-helpers");
const { query } = require("@/lib/db");
const { openStreetMapReverse } = require("@/lib/google");

exports.dynamic = "force-dynamic";

function finiteCoordinate(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

exports.POST = withHandler(async (request) => {
  const user = await requireAuth(request);
  const body = await request.json().catch(() => ({}));
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const locationType = String(body.location_type || "").trim();
  const inputText = String(body.input_text || "").trim();

  if (!finiteCoordinate(lat, -90, 90)) throw new BadRequestError("Invalid latitude");
  if (!finiteCoordinate(lng, -180, 180)) throw new BadRequestError("Invalid longitude");
  if (!["pickup", "delivery"].includes(locationType)) {
    throw new BadRequestError("location_type must be pickup or delivery");
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
        WHERE is_active = TRUE
          AND country_code = 'RW'
        ORDER BY distance_km ASC
        LIMIT 1`,
      [lat, lng],
    ),
  ]);

  const closest = nearest.rows[0] || null;
  const address = reverse?.address || reverse?.display_name || closest?.name || "Confirmed location";
  const city = reverse?.city || reverse?.district || closest?.district || "";
  const sector = reverse?.sector || closest?.sector || "";
  const provider = reverse?.provider || "nominatim";
  const providerPlaceId = reverse?.place_id == null ? null : String(reverse.place_id);
  const knownDistance = closest ? Number(closest.distance_km) : null;
  const knownLocationId = closest && knownDistance <= 0.2 ? closest.id : null;

  return ok({
    lat,
    lng,
    address,
    formatted_address: reverse?.display_name || address,
    city,
    district: reverse?.district || closest?.district || "",
    sector,
    name: reverse?.name || closest?.name || address,
    source: "gps_confirmed",
    provider,
    provider_place_id: providerPlaceId,
    known_location_id: knownLocationId,
    confidence: 1,
    verification_required: false,
    confirmed_by_user: true,
    location_type: locationType,
    input_text: inputText,
    nearest_known_location: closest
      ? {
          id: closest.id,
          name: closest.name,
          district: closest.district,
          sector: closest.sector,
          distance_km: knownDistance,
        }
      : null,
    user_id: user?.id ?? user?.user_id ?? null,
  });
});
