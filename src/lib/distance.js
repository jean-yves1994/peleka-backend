const KEY = process.env.GOOGLE_MAPS_API_KEY;

function haversineKm(a, b) {
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function estimateMinutes(km) { return Math.max(5, Math.round((km / 35) * 60)); }

async function getDistanceMatrix(origin, destination) {
  if (!KEY) {
    const km = haversineKm(origin, destination);
    return { distance_km: Number(km.toFixed(2)), duration_minutes: estimateMinutes(km), source: 'haversine' };
  }
  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', `${origin.lat},${origin.lng}`);
  url.searchParams.set('destinations', `${destination.lat},${destination.lng}`);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('units', 'metric');
  url.searchParams.set('key', KEY);
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`Google Maps HTTP ${res.status}`);
    const json = await res.json();
    const el = json?.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK') throw new Error(`Google Maps element status: ${el?.status || json?.status}`);
    return {
      distance_km: Number((el.distance.value / 1000).toFixed(2)),
      duration_minutes: Number((el.duration.value / 60).toFixed(2)),
      source: 'google',
    };
  } catch (err) {
    console.warn('[distance] falling back to haversine:', err.message);
    const km = haversineKm(origin, destination);
    return { distance_km: Number(km.toFixed(2)), duration_minutes: estimateMinutes(km), source: 'haversine' };
  }
}
module.exports = { getDistanceMatrix, haversineKm, estimateMinutes };
