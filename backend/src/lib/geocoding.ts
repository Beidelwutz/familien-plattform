import crypto from 'crypto';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

export interface GeocodingResult {
  lat: number;
  lng: number;
  confidence: number;
  normalizedAddress: string;
  district?: string;
  provider: string;
}

/**
 * Generate a hash for an address (for caching)
 */
export function hashAddress(address: string): string {
  const normalized = address.toLowerCase().trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 64);
}

/**
 * Nominatim API response structure
 */
interface NominatimResponse {
  lat: string;
  lon: string;
  display_name: string;
  importance: number;
  address?: {
    suburb?: string;
    neighbourhood?: string;
    city_district?: string;
    city?: string;
    town?: string;
    village?: string;
  };
}

/**
 * Rate limiter for Nominatim (max 1 request per second)
 */
let lastNominatimRequest = 0;
const NOMINATIM_RATE_LIMIT_MS = 1100; // 1.1 seconds between requests

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLast = now - lastNominatimRequest;
  if (timeSinceLast < NOMINATIM_RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, NOMINATIM_RATE_LIMIT_MS - timeSinceLast));
  }
  lastNominatimRequest = Date.now();
}

/**
 * Geocode an address using Nominatim
 */
async function geocodeWithNominatim(address: string): Promise<GeocodingResult | null> {
  await waitForRateLimit();

  const nominatimUrl = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
  const userAgent = 'Kiezling/1.0 (Event Aggregator for Families)';

  try {
    const params = new URLSearchParams({
      q: address,
      format: 'json',
      addressdetails: '1',
      limit: '1',
      countrycodes: 'de', // Focus on Germany
    });

    const response = await fetch(`${nominatimUrl}/search?${params}`, {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      logger.warn('Nominatim request failed', { status: response.status, address });
      return null;
    }

    const results = await response.json() as NominatimResponse[];
    
    if (results.length === 0) {
      logger.info('No geocoding results', { address });
      return null;
    }

    const result = results[0];
    const lat = parseFloat(result.lat);
    const lng = parseFloat(result.lon);

    // Calculate confidence based on importance
    const confidence = Math.min(1, result.importance || 0.5);

    // Extract district from address
    const district = result.address?.suburb 
      || result.address?.neighbourhood 
      || result.address?.city_district
      || result.address?.city
      || result.address?.town
      || result.address?.village;

    return {
      lat,
      lng,
      confidence,
      normalizedAddress: result.display_name,
      district,
      provider: 'nominatim',
    };
  } catch (error) {
    logger.error('Geocoding error', { error: String(error), address });
    return null;
  }
}

/**
 * Geocode an address with caching
 */
export async function geocodeAddress(address: string): Promise<GeocodingResult | null> {
  if (!address || address.trim().length < 5) {
    return null;
  }

  const addressHash = hashAddress(address);

  // Check cache first
  try {
    const cached = await prisma.geocodeCache.findUnique({
      where: { address_hash: addressHash }
    });

    if (cached) {
      logger.debug('Geocode cache hit', { address: address.substring(0, 50) });
      return {
        lat: Number(cached.lat),
        lng: Number(cached.lng),
        confidence: Number(cached.confidence) || 0.5,
        normalizedAddress: cached.normalized_address || address,
        district: cached.district_canonical || undefined,
        provider: cached.provider,
      };
    }
  } catch (error) {
    logger.warn('Cache lookup failed', { error: String(error) });
  }

  // Geocode with Nominatim
  const result = await geocodeWithNominatim(address);

  if (!result) {
    return null;
  }

  // Save to cache
  try {
    await prisma.geocodeCache.create({
      data: {
        address_hash: addressHash,
        original_address: address,
        normalized_address: result.normalizedAddress,
        lat: result.lat,
        lng: result.lng,
        confidence: result.confidence,
        provider: result.provider,
        district_canonical: result.district || null,
      }
    });
    logger.debug('Geocode cached', { address: address.substring(0, 50) });
  } catch (error) {
    // Ignore cache write errors (might be duplicate)
    logger.debug('Cache write skipped', { error: String(error) });
  }

  return result;
}

/**
 * Geocode an event if it has an address but no coordinates
 */
export async function geocodeEventIfNeeded(eventId: string): Promise<boolean> {
  const event = await prisma.canonicalEvent.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      location_address: true,
      location_lat: true,
      location_lng: true,
      location_district: true,
    }
  });

  if (!event) {
    return false;
  }

  // Skip if already has coordinates
  if (event.location_lat && event.location_lng) {
    return true;
  }

  // Skip if no address
  if (!event.location_address) {
    return false;
  }

  // Geocode
  const result = await geocodeAddress(event.location_address);

  if (!result) {
    return false;
  }

  // Update event
  await prisma.canonicalEvent.update({
    where: { id: eventId },
    data: {
      location_lat: result.lat,
      location_lng: result.lng,
      location_district: result.district || event.location_district,
    }
  });

  logger.info('Event geocoded', { eventId, lat: result.lat, lng: result.lng });
  return true;
}

/**
 * Batch geocode events that are missing coordinates
 */
export async function batchGeocodeEvents(limit: number = 10): Promise<{
  processed: number;
  geocoded: number;
  failed: number;
}> {
  const events = await prisma.canonicalEvent.findMany({
    where: {
      location_address: { not: null },
      OR: [
        { location_lat: null },
        { location_lng: null },
      ],
    },
    select: { id: true },
    take: limit,
  });

  let geocoded = 0;
  let failed = 0;

  for (const event of events) {
    const success = await geocodeEventIfNeeded(event.id);
    if (success) {
      geocoded++;
    } else {
      failed++;
    }
  }

  return {
    processed: events.length,
    geocoded,
    failed,
  };
}
