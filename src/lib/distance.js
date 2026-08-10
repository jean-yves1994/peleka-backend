/**
 * Distance between two points.
 *
 * WHY THIS MATTERS NOW
 * Your test shipment recorded `distance_km: 0.00` because pickup and delivery
 * carried identical coordinates. Under the old per-km formula that mostly hid
 * itself — base_fare dominated the total anyway. Under band pricing it doesn't:
 * every trip would price into the 0-10 km band at 2 000 RWF regardless of how
 * far it actually is. So distance now has to be right.
 *
 * TWO OPTIONS, AND AN HONEST NOTE ABOUT EACH
 *
 *  1. estimateRoadKm() — haversine × a road factor. No network call, instant.
 *     But straight-line distance UNDERSTATES road distance, typically by
 *     20-40% in a hilly, winding city like Kigali. An 11 km road trip can
 *     measure 8 km straight-line and price a band too low.
 *
 *  2. roadDistance() — asks OSRM for actual driving distance. Accurate, but
 *     adds a network round-trip to shipment creation.
 *
 * roadDistance() tries OSRM and falls back to the estimate, so you get accuracy
 * when the router is up and never a failed shipment when it isn't.
 *
 * ⚠️ ROAD_FACTOR = 1.3 is an ESTIMATE, not a measured constant for Kigali.
 *    Before relying on it commercially, sample a dozen real deliveries, compare
 *    rider odometer readings against what this returns, and tune it.
 */

const EARTH_RADIUS_KM = 6371;

/** Straight-line → road multiplier. Tune against real trips. */
const ROAD_FACTOR = Number(process.env.DISTANCE_ROAD_FACTOR || 1.3);

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Estimated road distance in km, 2dp. Returns 0 for identical points. */
function estimateRoadKm(lat1, lng1, lat2, lng2) {
  const straight = haversine(lat1, lng1, lat2, lng2);
  return Math.round(straight * ROAD_FACTOR * 100) / 100;
}

/**
 * Actual driving distance from OSRM, falling back to the estimate.
 *
 * ⚠️ router.project-osrm.org is a rate-limited demo server with no uptime
 *    guarantee. Fine for testing; self-host before production and set
 *    OSRM_BASE_URL.
 *
 * @returns {Promise<{km:number, minutes:number, source:'osrm'|'estimate'}>}
 */
async function roadDistance(lat1, lng1, lat2, lng2, { timeoutMs = 4000 } = {}) {
  const base = (process.env.OSRM_BASE_URL || 'https://router.project-osrm.org')
    .replace(/\/+$/, '');
  const url = `${base}/route/v1/driving/${lng1},${lat1};${lng2},${lat2}`
    + `?overview=false&alternatives=false`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`OSRM returned ${res.status}`);

    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) throw new Error('OSRM returned no route');

    return {
      km: Math.round((route.distance / 1000) * 100) / 100,
      minutes: Math.round(route.duration / 60),
      source: 'osrm',
    };
  } catch (e) {
    console.warn(`[distance] OSRM lookup failed (${e.message}) — using estimate.`);
    const km = estimateRoadKm(lat1, lng1, lat2, lng2);
    return {
      km,
      // ~20 km/h average in Kigali traffic. Also an estimate.
      minutes: Math.max(5, Math.round((km / 20) * 60)),
      source: 'estimate',
    };
  }
}

module.exports = { haversine, estimateRoadKm, roadDistance, ROAD_FACTOR };
