/**
 * GET /api/admin/riders/live-locations?withinMinutes=10&status=online,busy
 * Returns all riders with a recent location ping — ready for Google Map polling.
 */
const { query } = require('@/lib/db');
const { requireRole } = require('@/lib/auth');
const { ok } = require('@/lib/response');
const { withHandler } = require('@/lib/route-helpers');

exports.dynamic = 'force-dynamic';
const DEFAULT_WITHIN_MINUTES = 10;

exports.GET = withHandler(async (request) => {
  await requireRole(request, ['admin','dispatcher']);
  const url = new URL(request.url);
  const within = Math.min(1440, Math.max(1,
    parseInt(url.searchParams.get('withinMinutes') || String(DEFAULT_WITHIN_MINUTES), 10)
  ));
  const statusesParam = (url.searchParams.get('status') || 'online,busy').split(',').map(s => s.trim()).filter(Boolean);
  const validStatuses = ['online','busy','approved'];
  const statuses = statusesParam.filter(s => validStatuses.includes(s));

  const { rows } = await query(
    `SELECT
        u.id, u.full_name, u.phone, u.avatar_url,
        rp.status, rp.vehicle_type, rp.vehicle_plate,
        rp.rating_avg, rp.completed_jobs,
        rp.current_lat AS lat, rp.current_lng AS lng, rp.last_location_at,
        (SELECT row_to_json(s.*) FROM (
          SELECT id, tracking_number, status, pickup_lat, pickup_lng, delivery_lat, delivery_lng
            FROM shipments
           WHERE rider_id=u.id
             AND status IN ('assigned','rider_en_route_to_pickup','picked_up','in_transit','out_for_delivery')
           ORDER BY assigned_at DESC LIMIT 1
        ) s) AS active_shipment
       FROM users u JOIN rider_profiles rp ON rp.user_id=u.id
      WHERE u.role='rider' AND u.deleted_at IS NULL
        AND rp.current_lat IS NOT NULL AND rp.current_lng IS NOT NULL
        AND rp.last_location_at >= NOW() - ($1::int * INTERVAL '1 minute')
        AND rp.status = ANY($2::rider_status[])
      ORDER BY rp.last_location_at DESC`,
    [within, statuses]
  );
  return ok({
    generated_at: new Date().toISOString(),
    within_minutes: within, statuses, count: rows.length, riders: rows,
  });
});
