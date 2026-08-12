const { query } = require("@/lib/db");
const { requireAuth } = require("@/lib/auth");
const { ok } = require("@/lib/response");
const { withHandler } = require("@/lib/route-helpers");

/**
 * GET /api/locations/search?q=kimi — place lookup for the pickup/delivery picker.
 *
 * Written against your actual known_locations table:
 *     id, name, district, sector, latitude, longitude, source, created_at
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RANKING
 *
 * Ordering is the whole feature once the table has more than a few dozen rows.
 * A picker that buries Kimironko Market under twenty bus stops is worse than no
 * picker at all.
 *
 *   1. exact name match     typing "Remera" in full puts Remera itself first,
 *                           above "Remera Bus Park"
 *   2. name starts with     "kimi" → Kimironko before Nyakabanda Kimisange
 *   3. sector starts with   "gasa" → everything in Gasabo
 *   4. name contains
 *   5. district or sector contains anywhere
 *
 * Shorter names break ties, on the reasoning that "Remera" is more likely what
 * someone meant than "Remera Protestant Church Annex".
 */

exports.dynamic = "force-dynamic";

exports.GET = withHandler(async (request) => {
  // Authenticated but any role — riders and dispatchers need this too.
  await requireAuth(request);

  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim();
  const limit = Math.min(
    30,
    Math.max(1, Number(url.searchParams.get("limit") || 15)),
  );

  // No query: the picker's opening state. Without a usage counter there's
  // nothing to rank by, so this is just a stable alphabetical starting point.
  if (!q) {
    const { rows } = await query(
      `SELECT id, name, district, sector, latitude, longitude
         FROM known_locations
        ORDER BY name ASC
        LIMIT $1`,
      [limit],
    );
    return ok(rows, { mode: "browse" });
  }

  // Single-character queries match half the table and are never useful.
  if (q.length < 2) return ok([], { mode: "search", query: q });

  const { rows } = await query(
    `SELECT id, name, district, sector, latitude, longitude,
            CASE
              WHEN lower(name) = lower($1)  THEN 1
              WHEN name ILIKE $2            THEN 2
              WHEN sector ILIKE $2          THEN 3
              WHEN name ILIKE $3            THEN 4
              ELSE 5
            END AS match_rank
       FROM known_locations
      WHERE name ILIKE $3
         OR district ILIKE $3
         OR sector ILIKE $3
      ORDER BY match_rank ASC, length(name) ASC, name ASC
      LIMIT $4`,
    [q, `${q}%`, `%${q}%`, limit],
  );

  return ok(rows, { mode: "search", query: q });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * OPTIONAL — uncomment after running migration 0015
 *
 * POST /api/locations/search   { "location_id": "uuid" }
 *
 * Records that a place was chosen, so popular places surface faster. This is
 * what makes the picker improve with use rather than staying alphabetical
 * forever.
 *
 * Fire-and-forget: a failure here must never block creating a shipment, so it
 * always returns 200.
 */
// exports.POST = withHandler(async (request) => {
//   await requireAuth(request);
//
//   let id = null;
//   try {
//     const body = await request.json();
//     id = body?.location_id ?? null;
//   } catch (_) { /* malformed body — ignore */ }
//
//   if (id) {
//     try {
//       await query(
//         `UPDATE known_locations SET usage_count = usage_count + 1 WHERE id = $1`,
//         [id]
//       );
//     } catch (e) {
//       console.warn(`[locations] usage bump failed for ${id}: ${e.message}`);
//     }
//   }
//   return ok({ recorded: Boolean(id) });
// });
