import crypto from 'crypto';
import { prisma } from './prisma.js';

/**
 * Generates an idempotency key from source_id, fingerprint, and start_datetime
 */
export function generateIdempotencyKey(
  sourceId: string,
  fingerprint: string,
  startDatetime: Date | string
): string {
  const dateStr = typeof startDatetime === 'string' 
    ? startDatetime 
    : startDatetime.toISOString();
  
  const payload = `${sourceId}|${fingerprint}|${dateStr}`;
  return crypto.createHash('sha256').update(payload).digest('hex').substring(0, 32);
}

/**
 * Computes a fingerprint for deduplication based on title, date, and location
 */
export function computeFingerprint(
  title: string,
  startDatetime: Date | string,
  lat?: number | null,
  lng?: number | null
): string {
  // Normalize title: lowercase, remove special chars, trim
  const normalizedTitle = title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Date string (date only, no time)
  const date = typeof startDatetime === 'string' 
    ? new Date(startDatetime) 
    : startDatetime;
  const dateStr = date.toISOString().split('T')[0];
  
  // Geo-hash approximation (round to ~100m precision)
  let geoStr = '';
  if (lat != null && lng != null) {
    geoStr = `${lat.toFixed(3)}|${lng.toFixed(3)}`;
  }
  
  const payload = `${normalizedTitle}|${dateStr}|${geoStr}`;
  return crypto.createHash('sha256').update(payload).digest('hex').substring(0, 32);
}

/**
 * Source priority for merging (lower = higher priority)
 */
export const SOURCE_PRIORITY: Record<string, number> = {
  manual: 1,    // Admin-Eingabe
  partner: 1,   // Partner-Upload
  provider: 2,  // Provider-Eingabe
  api: 3,       // Offizielle APIs
  rss: 4,       // RSS Feeds
  ics: 4,       // ICS Calendars
  scraper: 5,   // Web Scraper
};

/**
 * Check if a field should be updated based on source priority and locked fields
 */
export function shouldUpdateField(
  field: string,
  existingSourcePriority: number,
  newSourcePriority: number,
  lockedFields: string[]
): boolean {
  // Never update locked fields
  if (lockedFields.includes(field)) {
    return false;
  }
  // Only update if new source has equal or higher priority (lower number)
  return newSourcePriority <= existingSourcePriority;
}

/**
 * Result of an idempotent ingest operation
 */
export interface IngestResult {
  action: 'created' | 'updated' | 'skipped' | 'duplicate';
  eventId: string;
  eventSourceId: string;
  message: string;
  fieldsUpdated?: string[];
}

/**
 * Finds an existing EventSource by fingerprint and source_id
 */
export async function findExistingEventSource(
  fingerprint: string,
  sourceId: string
): Promise<{
  eventSource: any;
  canonicalEvent: any;
} | null> {
  const eventSource = await prisma.eventSource.findFirst({
    where: {
      fingerprint,
      source_id: sourceId,
    },
    include: {
      canonical_event: {
        include: {
          primary_source: {
            include: {
              source: true,
            }
          }
        }
      }
    }
  });
  
  if (!eventSource) {
    return null;
  }
  
  return {
    eventSource,
    canonicalEvent: eventSource.canonical_event,
  };
}

/**
 * Finds a potential duplicate event by fingerprint across all sources
 */
export async function findDuplicateByFingerprint(
  fingerprint: string
): Promise<any | null> {
  const eventSource = await prisma.eventSource.findFirst({
    where: { fingerprint },
    include: {
      canonical_event: true,
    }
  });
  
  return eventSource?.canonical_event || null;
}
