/**
 * Event Query Helpers
 * 
 * Zentrale Filter für displayable Events auf der Familienseite.
 * Alle API-Endpunkte sollten diese Helper nutzen für konsistente Filterung.
 */

import { Prisma } from '@prisma/client';

// Age ratings die NICHT auf der Familienseite angezeigt werden dürfen
export const RESTRICTED_AGE_RATINGS = ['16+', '18+'] as const;

/**
 * Zentraler Filter für displayable Events
 * 
 * Ein Event ist "displayable" wenn:
 * - status = 'published'
 * - start_datetime >= now
 * - is_cancelled = false
 * - age_rating nicht in ['16+', '18+'] (oder null/nicht vorhanden)
 * 
 * @param now - Referenzzeitpunkt (default: jetzt)
 * @returns Prisma where clause
 */
export function whereDisplayable(now: Date = new Date()): Prisma.CanonicalEventWhereInput {
  return {
    status: 'published',
    start_datetime: { gte: now },
    is_cancelled: false,
    // age_rating Filter: erlaubt null/undefined oder nicht-restringierte Ratings
    // Hinweis: Wenn age_rating Feld noch nicht in DB existiert, wird dieser Filter ignoriert
    NOT: {
      age_rating: { in: [...RESTRICTED_AGE_RATINGS] }
    }
  };
}

/**
 * Erweitert whereDisplayable mit zusätzlichen Filtern
 * 
 * @param now - Referenzzeitpunkt
 * @param additionalFilters - Zusätzliche Prisma where clauses
 * @returns Kombinierte Prisma where clause
 */
export function whereDisplayableWith(
  now: Date = new Date(),
  additionalFilters: Prisma.CanonicalEventWhereInput
): Prisma.CanonicalEventWhereInput {
  return {
    AND: [
      whereDisplayable(now),
      additionalFilters
    ]
  };
}

/**
 * Validierung Input für canPublish
 */
export interface CanPublishInput {
  title?: string | null;
  start_datetime?: Date | null;
  location_address?: string | null;
  location_lat?: number | Prisma.Decimal | null;
  location_lng?: number | Prisma.Decimal | null;
  is_cancelled?: boolean;
  age_rating?: string | null;
}

/**
 * Validierung Result
 */
export interface CanPublishResult {
  valid: boolean;
  reason?: string;
}

/**
 * Prüft ob ein Event die Mindestanforderungen für Veröffentlichung erfüllt
 * 
 * Anforderungen:
 * - Titel vorhanden und >= 5 Zeichen
 * - start_datetime vorhanden
 * - Entweder location_address ODER (location_lat UND location_lng) vorhanden
 * - Event nicht abgesagt
 * - age_rating nicht 16+ oder 18+ (nicht familiengeeignet)
 * 
 * @param event - Event-Daten zu validieren
 * @returns Validierungsergebnis mit Grund bei Fehler
 */
export function canPublish(event: CanPublishInput): CanPublishResult {
  // Titel prüfen
  if (!event.title || event.title.trim().length < 5) {
    return { 
      valid: false, 
      reason: 'Titel zu kurz (mindestens 5 Zeichen erforderlich)' 
    };
  }
  
  // Startdatum prüfen
  if (!event.start_datetime) {
    return { 
      valid: false, 
      reason: 'Startdatum fehlt' 
    };
  }
  
  // Location prüfen (Adresse ODER Koordinaten)
  const hasAddress = event.location_address && event.location_address.trim().length > 0;
  const hasCoords = event.location_lat != null && event.location_lng != null;
  
  if (!hasAddress && !hasCoords) {
    return { 
      valid: false, 
      reason: 'Adresse oder Koordinaten fehlen' 
    };
  }
  
  // Abgesagt prüfen
  if (event.is_cancelled) {
    return { 
      valid: false, 
      reason: 'Event ist abgesagt' 
    };
  }
  
  // Age rating prüfen
  if (event.age_rating && RESTRICTED_AGE_RATINGS.includes(event.age_rating as typeof RESTRICTED_AGE_RATINGS[number])) {
    return { 
      valid: false, 
      reason: `age_rating ${event.age_rating} nicht für Familienseite geeignet` 
    };
  }
  
  return { valid: true };
}

/**
 * Prüft ob ein age_rating auf der Familienseite erlaubt ist
 * 
 * @param ageRating - Das age_rating zu prüfen
 * @returns true wenn erlaubt, false wenn nicht
 */
export function isAgeRatingAllowed(ageRating: string | null | undefined): boolean {
  if (!ageRating) return true;
  return !RESTRICTED_AGE_RATINGS.includes(ageRating as typeof RESTRICTED_AGE_RATINGS[number]);
}
