/**
 * Driving distance used by Peleka pricing.
 *
 * A straight-line estimate is useful for diagnostics, but it must never be
 * silently presented as a verified driving route. Kigali's road network is
 * hilly and winding, so an underestimated route can directly cause underbilling.
 */

const EARTH_RADIUS_KM = 6371;
const ROAD_FACTOR = Number(process.env.DISTANCE_ROAD_FACTOR || 1.3);

const toRad = (deg) => (deg * Math.PI) / 180;

function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateRoadKm(lat1, lng1, lat2, lng2) {
  const straight = haversine(lat1, lng1, lat2, lng2);
  return Math.round(straight * ROAD_FACTOR * 100) / 100;
}

/**
 * Get an actual driving route from OSRM.
 *
 * The fallback remains available for quote previews so the UI can explain that
 * routing is temporarily unavailable. Shipment creation can require a verified
 * route with REQUIRE_ROUTED_DISTANCE=true.
 *
 * @returns {Promise<{km:number, minutes:number, source:'osrm'|'estimate'}>}
 */
async function roadDistance(lat1, lng1, lat2, lng2, { timeoutMs = 6000 } = {}) {
  const base = (process.env.OSRM_BASE_URL || "https://router.project-osrm.org")
    .replace(/\/+$/, "");
  const url = `${base}/route/v1/driving/${lng1},${lat1};${lng2},${lat2}`
    + `?overview=false&alternatives=false&steps=false`;

  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`OSRM returned ${res.status}`);

    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route || !Number.isFinite(Number(route.distance))) {
      throw new Error("OSRM returned no usable route");
    }

    return {
      km: Math.round((Number(route.distance) / 1000) * 100) / 100,
      minutes: Math.max(1, Math.round(Number(route.duration || 0) / 60)),
      source: "osrm",
    };
  } catch (e) {
    console.warn(`[distance] OSRM lookup failed (${e.message}) — estimate returned.`);
    const km = estimateRoadKm(lat1, lng1, lat2, lng2);
    return {
      km,
      minutes: Math.max(5, Math.round((km / 20) * 60)),
      source: "estimate",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { haversine, estimateRoadKm, roadDistance, ROAD_FACTOR };
