import { prisma } from './prisma.js';

/**
 * Haversine distance calculation (for client-side fallback)
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000; // Earth radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Search events within a radius using PostGIS
 */
export async function searchEventsWithinRadius(
  lat: number,
  lng: number,
  radiusKm: number,
  options: {
    limit?: number;
    offset?: number;
    status?: string;
    includeCancelled?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
  } = {}
): Promise<{
  events: any[];
  total: number;
}> {
  const {
    limit = 20,
    offset = 0,
    status = 'published',
    includeCancelled = false,
    dateFrom = new Date(),
    dateTo,
  } = options;

  const radiusMeters = radiusKm * 1000;

  // Build WHERE conditions
  let whereConditions = `
    status = '${status}'
    AND location_point IS NOT NULL
    AND ST_DWithin(
      location_point,
      ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
      $3
    )
  `;

  if (!includeCancelled) {
    whereConditions += ` AND is_cancelled = false`;
  }

  if (dateFrom) {
    whereConditions += ` AND start_datetime >= '${dateFrom.toISOString()}'`;
  }

  if (dateTo) {
    whereConditions += ` AND start_datetime <= '${dateTo.toISOString()}'`;
  }

  // Count total
  const countResult = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
    SELECT COUNT(*) as count
    FROM canonical_events
    WHERE ${whereConditions}
  `, lng, lat, radiusMeters);

  const total = Number(countResult[0]?.count || 0);

  // Fetch events with distance
  const events = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      *,
      ST_Distance(
        location_point,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
      ) as distance_meters
    FROM canonical_events
    WHERE ${whereConditions}
    ORDER BY distance_meters ASC, start_datetime ASC
    LIMIT $4 OFFSET $5
  `, lng, lat, radiusMeters, limit, offset);

  return { events, total };
}

/**
 * Get events sorted by distance from a point
 */
export async function getEventsByDistance(
  lat: number,
  lng: number,
  options: {
    limit?: number;
    offset?: number;
    maxDistanceKm?: number;
    status?: string;
    includeCancelled?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
  } = {}
): Promise<{
  events: any[];
  total: number;
}> {
  const {
    limit = 20,
    offset = 0,
    maxDistanceKm = 50, // Default 50km max
    status = 'published',
    includeCancelled = false,
    dateFrom = new Date(),
    dateTo,
  } = options;

  // Use radius search with a default max distance
  return searchEventsWithinRadius(lat, lng, maxDistanceKm, {
    limit,
    offset,
    status,
    includeCancelled,
    dateFrom,
    dateTo,
  });
}

/**
 * Add distance to events (for results that already have lat/lng)
 */
export function addDistanceToEvents(
  events: any[],
  userLat: number,
  userLng: number
): any[] {
  return events.map((event) => {
    if (event.location_lat && event.location_lng) {
      const distance = haversineDistance(
        userLat,
        userLng,
        Number(event.location_lat),
        Number(event.location_lng)
      );
      return {
        ...event,
        distance_meters: Math.round(distance),
        distance_km: Math.round(distance / 100) / 10, // Round to 1 decimal
      };
    }
    return event;
  });
}
