/**
 * Merge logic for batch ingest with field-level provenance tracking.
 * Implements Option A: Backend makes all final merge decisions.
 */

import { EventStatus, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { SOURCE_PRIORITY, computeFingerprint } from './idempotency.js';
import { calculateCompleteness, determineInitialStatus, determineStatusFromAI, type AIScoreInput } from './eventCompleteness.js';

// Staleness threshold in days
const STALENESS_DAYS = 180;

/** Per-field status for missing data and crawl/AI attempts (used in field_fill_status JSON) */
export type FieldSource = 'feed' | 'crawl' | 'ai' | 'manual' | 'normalizer' | 'deep_fetch';

export type FieldFillStatusValue = {
  status: 'filled' | 'missing' | 'crawl_pending' | 'crawl_failed' | 'ai_pending' | 'ai_failed';
  error?: string;
  last_attempt?: string;
  source?: FieldSource;
  confidence?: number;
};

// PriceType validation
const VALID_PRICE_TYPES = ['free', 'paid', 'range', 'unknown', 'donation'] as const;
type PriceType = typeof VALID_PRICE_TYPES[number];

function sanitizePriceType(val: string | null | undefined): PriceType {
  if (val && (VALID_PRICE_TYPES as readonly string[]).includes(val)) return val as PriceType;
  return 'unknown';
}

const KEY_FIELDS_FOR_FILL_STATUS = ['location_address', 'start_datetime', 'end_datetime', 'ai_summary_short'] as const;

function buildFieldFillStatus(
  eventLike: Record<string, any>,
  provenance: Record<string, string>,
  nowIso: string
): Record<string, FieldFillStatusValue> {
  const status: Record<string, FieldFillStatusValue> = {};
  for (const field of KEY_FIELDS_FOR_FILL_STATUS) {
    const value = eventLike[field];
    const hasValue = value !== null && value !== undefined && value !== '' &&
      !(Array.isArray(value) && value.length === 0);
    if (hasValue) {
      status[field] = { status: 'filled', source: (provenance[field] as 'feed' | 'crawl' | 'ai' | 'manual') || 'feed', last_attempt: nowIso };
    } else {
      status[field] = { status: 'missing', last_attempt: nowIso };
    }
  }
  return status;
}

/**
 * Canonical Candidate from AI-Worker
 */
export interface CanonicalCandidate {
  source_type: 'rss' | 'ics' | 'scraper' | 'api' | 'partner';
  source_url: string;
  external_id?: string;
  fingerprint: string;
  raw_hash: string;
  extracted_at: string;
  
  data: {
    title: string;
    description?: string;
    start_at?: string;  // Optional - RSS feeds often don't have event dates
    end_at?: string;
    timezone_original?: string;
    venue_name?: string;
    address?: string;
    city?: string;
    postal_code?: string;
    country_code?: string;
    lat?: number;
    lng?: number;
    price_type?: string;
    price_min?: number;
    price_max?: number;
    price_details?: Record<string, any> | null;
    age_min?: number;
    age_max?: number;
    categories?: string[];
    images?: string[];
    booking_url?: string;
    contact_email?: string;
    contact_phone?: string;
    is_indoor?: boolean;
    is_outdoor?: boolean;
    // Extended AI/worker fields (optional)
    age_recommendation_text?: string | null;
    sibling_friendly?: boolean | null;
    language?: string | null;
    complexity_level?: string | number | null;
    noise_level?: string | number | null;
    has_seating?: boolean | null;
    typical_wait_minutes?: number | null;
    food_drink_allowed?: boolean | null;
    // Recurrence / Availability
    recurrence_rule?: string | null;
    availability_status?: string | null;
  };
  
  ai?: {
    classification?: {
      categories: string[];
      age_min?: number;
      age_max?: number;
      is_indoor?: boolean;
      is_outdoor?: boolean;
      confidence: number;
      ai_summary_short?: string;
      ai_summary_highlights?: string[];
      ai_fit_blurb?: string;
      summary_confidence?: number;
      extracted_start_datetime?: string;
      extracted_end_datetime?: string;
      datetime_confidence?: number;
      extracted_location_address?: string;
      extracted_location_district?: string;
      location_confidence?: number;
      age_recommendation_text?: string;
      sibling_friendly?: boolean;
      language?: string;
      complexity_level?: string;
      noise_level?: string;
      has_seating?: boolean;
      typical_wait_minutes?: number;
      food_drink_allowed?: boolean;
      // AI-extracted price (Phase 0.2: saubere Typen statt 'as any')
      extracted_price_type?: string | null;
      extracted_price_min?: number | null;
      extracted_price_max?: number | null;
      price_confidence?: number;
      // AI-extracted venue (Location-Entity-Split)
      extracted_venue_name?: string | null;
      extracted_address_line?: string | null;
      extracted_city?: string | null;
      extracted_postal_code?: string | null;
      venue_confidence?: number;
      // AI-extracted cancellation
      is_cancelled_or_postponed?: boolean;
    };
    scores?: {
      relevance: number;
      quality: number;
      family_fit: number;
      stressfree?: number;
    };
    geocode?: {
      lat: number;
      lng: number;
      confidence: number;
      match_type?: string;
    };
  };
  
  versions?: {
    parser: string;
    normalizer: string;
  };
}

/**
 * Result for a single ingested item
 */
export interface IngestItemResult {
  fingerprint: string;
  status: 'created' | 'updated' | 'unchanged' | 'ignored' | 'conflict';
  event_id?: string;
  raw_item_id?: string;
  applied_fields: string[];
  ignored_fields: string[];
  merge_reasons: MergeReason[];
}

export interface MergeReason {
  field: string;
  reason: 'locked' | 'source_priority_lower' | 'stale_data' | 'null_value' | 'unchanged' | 'new_field';
  current_source?: string;
  candidate_source?: string;
}

/**
 * Check if a field should be updated based on staleness rule
 */
function isStale(lastUpdated: Date | null, days: number = STALENESS_DAYS): boolean {
  if (!lastUpdated) return false;
  const now = new Date();
  const diff = now.getTime() - lastUpdated.getTime();
  return diff > days * 24 * 60 * 60 * 1000;
}

/**
 * Determine if a field should be updated
 */
function shouldUpdateFieldWithProvenance(
  fieldName: string,
  candidateValue: any,
  existingValue: any,
  candidateSourceType: string,
  existingProvenance: Record<string, string>,
  fieldUpdatedAt: Record<string, string>,
  lockedFields: string[]
): { shouldUpdate: boolean; reason: MergeReason['reason'] } {
  // Never update locked fields
  if (lockedFields.includes(fieldName)) {
    return { shouldUpdate: false, reason: 'locked' };
  }
  
  // Don't update if candidate value is null/undefined
  if (candidateValue === null || candidateValue === undefined) {
    return { shouldUpdate: false, reason: 'null_value' };
  }
  
  // If field doesn't exist yet, always set it
  if (existingValue === null || existingValue === undefined) {
    return { shouldUpdate: true, reason: 'new_field' };
  }
  
  // Check source priority
  const existingSourceType = existingProvenance[fieldName] || 'scraper';
  const existingPriority = SOURCE_PRIORITY[existingSourceType] || 5;
  const candidatePriority = SOURCE_PRIORITY[candidateSourceType] || 5;
  
  // Higher priority (lower number) can always update
  if (candidatePriority < existingPriority) {
    return { shouldUpdate: true, reason: 'source_priority_lower' };
  }
  
  // Same priority - check if values are different
  if (candidatePriority === existingPriority) {
    if (JSON.stringify(candidateValue) === JSON.stringify(existingValue)) {
      return { shouldUpdate: false, reason: 'unchanged' };
    }
    return { shouldUpdate: true, reason: 'unchanged' };
  }
  
  // Lower priority - only update if existing is stale
  const lastUpdated = fieldUpdatedAt[fieldName] ? new Date(fieldUpdatedAt[fieldName]) : null;
  if (isStale(lastUpdated)) {
    return { shouldUpdate: true, reason: 'stale_data' };
  }
  
  return { shouldUpdate: false, reason: 'source_priority_lower' };
}

/**
 * Process a single candidate and merge into database
 */
export async function processSingleCandidate(
  candidate: CanonicalCandidate,
  sourceId: string,
  runId: string
): Promise<IngestItemResult> {
  const appliedFields: string[] = [];
  const ignoredFields: string[] = [];
  const mergeReasons: MergeReason[] = [];
  
  // Get source info
  const source = await prisma.source.findUnique({ where: { id: sourceId } });
  if (!source) {
    throw new Error(`Source ${sourceId} not found`);
  }
  
  const sourceType = source.type;
  const now = new Date();
  const nowIso = now.toISOString();
  
  // Find existing event by fingerprint
  const existingEventSource = await prisma.eventSource.findFirst({
    where: { fingerprint: candidate.fingerprint },
    include: {
      canonical_event: true
    }
  });
  
  // Create or update RawEventItem for audit trail (with tracking fields)
  const rawEventItem = await prisma.rawEventItem.upsert({
    where: {
      source_id_raw_hash: {
        source_id: sourceId,
        raw_hash: candidate.raw_hash,
      }
    },
    update: {
      // Update tracking fields
      run_id: runId,
      last_seen_at: now,
      seen_count: { increment: 1 },
      // Only update data if it's changed (raw_hash is same, so data should be same)
      fetched_at: new Date(candidate.extracted_at),
      // Update AI suggestions if provided
      ...(candidate.ai && { ai_suggestions: candidate.ai as any }),
    },
    create: {
      source_id: sourceId,
      run_id: runId,
      raw_hash: candidate.raw_hash,
      extracted_fields: candidate.data as any,
      source_url: candidate.source_url,
      external_id: candidate.external_id,
      fingerprint: candidate.fingerprint,
      parser_version: candidate.versions?.parser || '1.0.0',
      normalizer_version: candidate.versions?.normalizer || '1.0.0',
      ai_suggestions: candidate.ai as any,
      first_seen_at: now,
      last_seen_at: now,
      seen_count: 1,
      fetched_at: new Date(candidate.extracted_at),
    }
  });
  
  if (existingEventSource?.canonical_event) {
    // Event exists - check if we should update
    const existingEvent = existingEventSource.canonical_event;
    const lockedFields = (existingEvent.locked_fields as string[]) || [];
    const existingProvenance = (existingEvent.field_provenance as Record<string, string>) || {};
    const fieldUpdatedAt = (existingEvent.field_updated_at as Record<string, string>) || {};
    
    const updates: Record<string, any> = {};
    const newProvenance = { ...existingProvenance };
    const newFieldUpdatedAt = { ...fieldUpdatedAt };
    
    // Field mapping: candidate.data field -> db field
    const fieldMappings: Array<{ candidateField: string; dbField: string; value: any }> = [
      { candidateField: 'description', dbField: 'description_short', value: candidate.data.description?.substring(0, 500) },
      { candidateField: 'address', dbField: 'location_address', value: candidate.data.address },
      { candidateField: 'lat', dbField: 'location_lat', value: candidate.data.lat },
      { candidateField: 'lng', dbField: 'location_lng', value: candidate.data.lng },
      { candidateField: 'price_min', dbField: 'price_min', value: candidate.data.price_min },
      { candidateField: 'price_max', dbField: 'price_max', value: candidate.data.price_max },
      { candidateField: 'age_min', dbField: 'age_min', value: candidate.data.age_min },
      { candidateField: 'age_max', dbField: 'age_max', value: candidate.data.age_max },
      { candidateField: 'booking_url', dbField: 'booking_url', value: candidate.data.booking_url },
      { candidateField: 'contact_email', dbField: 'contact_email', value: candidate.data.contact_email },
      { candidateField: 'contact_phone', dbField: 'contact_phone', value: candidate.data.contact_phone },
      { candidateField: 'is_indoor', dbField: 'is_indoor', value: candidate.data.is_indoor },
      { candidateField: 'is_outdoor', dbField: 'is_outdoor', value: candidate.data.is_outdoor },
      { candidateField: 'images', dbField: 'image_urls', value: candidate.data.images },
      // New fields
      { candidateField: 'venue_name', dbField: 'venue_name', value: candidate.data.venue_name },
      { candidateField: 'city', dbField: 'city', value: candidate.data.city },
      { candidateField: 'postal_code', dbField: 'postal_code', value: candidate.data.postal_code },
      { candidateField: 'country_code', dbField: 'country_code', value: candidate.data.country_code },
      { candidateField: 'price_details', dbField: 'price_details', value: candidate.data.price_details },
      { candidateField: 'recurrence_rule', dbField: 'recurrence_rule', value: candidate.data.recurrence_rule },
      { candidateField: 'availability_status', dbField: 'availability_status', value: candidate.data.availability_status },
    ];
    
    // Apply AI suggestions if available
    if (candidate.ai?.classification) {
      const ai = candidate.ai.classification;
      const datetimeConfidence = ai.datetime_confidence || 0;
      const locationConfidence = ai.location_confidence || 0;
      
      // Basic AI fields
      if (ai.age_min !== undefined) {
        fieldMappings.push({ candidateField: 'ai_age_min', dbField: 'age_min', value: ai.age_min });
      }
      if (ai.age_max !== undefined) {
        fieldMappings.push({ candidateField: 'ai_age_max', dbField: 'age_max', value: ai.age_max });
      }
      if (ai.is_indoor !== undefined) {
        fieldMappings.push({ candidateField: 'ai_is_indoor', dbField: 'is_indoor', value: ai.is_indoor });
      }
      if (ai.is_outdoor !== undefined) {
        fieldMappings.push({ candidateField: 'ai_is_outdoor', dbField: 'is_outdoor', value: ai.is_outdoor });
      }
      
      // Extended AI fields
      if (ai.age_recommendation_text) {
        fieldMappings.push({ candidateField: 'ai_age_recommendation_text', dbField: 'age_recommendation_text', value: ai.age_recommendation_text });
      }
      if (ai.sibling_friendly !== undefined) {
        fieldMappings.push({ candidateField: 'ai_sibling_friendly', dbField: 'sibling_friendly', value: ai.sibling_friendly });
      }
      if (ai.language) {
        fieldMappings.push({ candidateField: 'ai_language', dbField: 'language', value: ai.language });
      }
      if (ai.complexity_level) {
        fieldMappings.push({ candidateField: 'ai_complexity_level', dbField: 'complexity_level', value: ai.complexity_level });
      }
      if (ai.noise_level) {
        fieldMappings.push({ candidateField: 'ai_noise_level', dbField: 'noise_level', value: ai.noise_level });
      }
      if (ai.has_seating !== undefined) {
        fieldMappings.push({ candidateField: 'ai_has_seating', dbField: 'has_seating', value: ai.has_seating });
      }
      if (ai.typical_wait_minutes !== undefined) {
        fieldMappings.push({ candidateField: 'ai_typical_wait_minutes', dbField: 'typical_wait_minutes', value: ai.typical_wait_minutes });
      }
      if (ai.food_drink_allowed !== undefined) {
        fieldMappings.push({ candidateField: 'ai_food_drink_allowed', dbField: 'food_drink_allowed', value: ai.food_drink_allowed });
      }
      
      // AI-extracted datetime (only if confidence >= 0.7 and no existing value)
      if (ai.extracted_start_datetime && datetimeConfidence >= 0.7 && !existingEvent.start_datetime) {
        try {
          fieldMappings.push({ candidateField: 'ai_start_datetime', dbField: 'start_datetime', value: new Date(ai.extracted_start_datetime) });
        } catch { /* ignore parse errors */ }
      }
      if (ai.extracted_end_datetime && datetimeConfidence >= 0.7 && !existingEvent.end_datetime) {
        try {
          fieldMappings.push({ candidateField: 'ai_end_datetime', dbField: 'end_datetime', value: new Date(ai.extracted_end_datetime) });
        } catch { /* ignore parse errors */ }
      }
      
      // AI-extracted location (only if confidence >= 0.7 and no existing value)
      if (ai.extracted_location_address && locationConfidence >= 0.7 && !existingEvent.location_address) {
        fieldMappings.push({ candidateField: 'ai_location_address', dbField: 'location_address', value: ai.extracted_location_address });
      }
      if (ai.extracted_location_district && locationConfidence >= 0.7 && !existingEvent.location_district) {
        fieldMappings.push({ candidateField: 'ai_location_district', dbField: 'location_district', value: ai.extracted_location_district });
      }
      
      // AI-extracted venue (Location-Entity-Split)
      const venueConfidence = ai.venue_confidence || 0;
      if (ai.extracted_venue_name && venueConfidence >= 0.7 && !(existingEvent as any).venue_name) {
        fieldMappings.push({ candidateField: 'ai_venue_name', dbField: 'venue_name', value: ai.extracted_venue_name });
      }
      if (ai.extracted_address_line && venueConfidence >= 0.7 && !existingEvent.location_address) {
        fieldMappings.push({ candidateField: 'ai_address_line', dbField: 'location_address', value: ai.extracted_address_line });
      }
      if (ai.extracted_city && !(existingEvent as any).city) {
        fieldMappings.push({ candidateField: 'ai_city', dbField: 'city', value: ai.extracted_city });
      }
      if (ai.extracted_postal_code && !(existingEvent as any).postal_code) {
        fieldMappings.push({ candidateField: 'ai_postal_code', dbField: 'postal_code', value: ai.extracted_postal_code });
      }
      
      // AI-extracted price (use == null, not falsy!)
      const priceConfidence = ai.price_confidence || 0;
      if (ai.extracted_price_type && priceConfidence >= 0.7 && (existingEvent as any).price_min == null) {
        if (ai.extracted_price_type === 'free' || ai.extracted_price_type === 'donation') {
          fieldMappings.push({ candidateField: 'ai_price_min', dbField: 'price_min', value: 0 });
          fieldMappings.push({ candidateField: 'ai_price_type', dbField: 'price_type', value: 'free' });
        } else if (ai.extracted_price_min != null) {
          fieldMappings.push({ candidateField: 'ai_price_min', dbField: 'price_min', value: ai.extracted_price_min });
          fieldMappings.push({ candidateField: 'ai_price_type', dbField: 'price_type', value: 'paid' });
        }
      }
      
      // AI-generated summaries
      if (ai.ai_summary_short) {
        fieldMappings.push({ candidateField: 'ai_summary_short', dbField: 'ai_summary_short', value: ai.ai_summary_short });
      }
      if (ai.ai_summary_highlights?.length) {
        fieldMappings.push({ candidateField: 'ai_summary_highlights', dbField: 'ai_summary_highlights', value: ai.ai_summary_highlights });
      }
      if (ai.ai_fit_blurb) {
        fieldMappings.push({ candidateField: 'ai_fit_blurb', dbField: 'ai_fit_blurb', value: ai.ai_fit_blurb });
      }
      if (ai.summary_confidence !== undefined && ai.summary_confidence !== null) {
        fieldMappings.push({ candidateField: 'ai_summary_confidence', dbField: 'ai_summary_confidence', value: ai.summary_confidence });
      }
    }
    
    // Apply AI geocode if we don't have coords
    if (candidate.ai?.geocode && !existingEvent.location_lat) {
      fieldMappings.push({ candidateField: 'ai_lat', dbField: 'location_lat', value: candidate.ai.geocode.lat });
      fieldMappings.push({ candidateField: 'ai_lng', dbField: 'location_lng', value: candidate.ai.geocode.lng });
    }
    
    for (const mapping of fieldMappings) {
      const existingValue = (existingEvent as any)[mapping.dbField];
      const { shouldUpdate, reason } = shouldUpdateFieldWithProvenance(
        mapping.dbField,
        mapping.value,
        existingValue,
        sourceType,
        existingProvenance,
        fieldUpdatedAt,
        lockedFields
      );
      
      if (shouldUpdate && mapping.value !== undefined && mapping.value !== null) {
        updates[mapping.dbField] = mapping.value;
        newProvenance[mapping.dbField] = sourceType;
        newFieldUpdatedAt[mapping.dbField] = nowIso;
        appliedFields.push(mapping.dbField);
      } else if (mapping.value !== undefined && mapping.value !== null) {
        ignoredFields.push(mapping.dbField);
        mergeReasons.push({
          field: mapping.dbField,
          reason,
          current_source: existingProvenance[mapping.dbField],
          candidate_source: sourceType,
        });
      }
    }
    
    // Update EventSource
    await prisma.eventSource.update({
      where: { id: existingEventSource.id },
      data: {
        fetched_at: now,
        normalized_data: candidate.data as any,
      }
    });
    
    // Update RawEventItem with result
    const ingestStatus = appliedFields.length > 0 ? 'updated' : 'unchanged';
    await prisma.rawEventItem.update({
      where: { id: rawEventItem.id },
      data: {
        canonical_event_id: existingEvent.id,
        ingest_status: ingestStatus,
        ingest_result: {
          applied_fields: appliedFields,
          ignored_fields: ignoredFields,
          merge_reasons: mergeReasons,
        } as any,
      }
    });
    
    if (Object.keys(updates).length > 0) {
      const mergedEvent = { ...existingEvent, ...updates };
      const newFieldFillStatus = buildFieldFillStatus(mergedEvent, newProvenance, nowIso);
      const existingFieldFillStatus = (existingEvent.field_fill_status as Record<string, FieldFillStatusValue>) || {};
      const combinedFieldFillStatus = { ...existingFieldFillStatus, ...newFieldFillStatus };
      await prisma.canonicalEvent.update({
        where: { id: existingEvent.id },
        data: {
          ...updates,
          field_provenance: newProvenance,
          field_updated_at: newFieldUpdatedAt,
          field_fill_status: combinedFieldFillStatus,
        }
      });
      
      return {
        fingerprint: candidate.fingerprint,
        status: 'updated',
        event_id: existingEvent.id,
        raw_item_id: rawEventItem.id,
        applied_fields: appliedFields,
        ignored_fields: ignoredFields,
        merge_reasons: mergeReasons,
      };
    }
    
    return {
      fingerprint: candidate.fingerprint,
      status: 'unchanged',
      event_id: existingEvent.id,
      raw_item_id: rawEventItem.id,
      applied_fields: [],
      ignored_fields: ignoredFields,
      merge_reasons: mergeReasons,
    };
  }
  
  // Create new event
  // Get AI classification for easier access
  const aiClassification = candidate.ai?.classification;
  const datetimeConfidence = aiClassification?.datetime_confidence || 0;
  const locationConfidence = aiClassification?.location_confidence || 0;
  
  // Determine start_datetime: use candidate data first, then AI-extracted (if confidence >= 0.7)
  let startDatetime = candidate.data.start_at ? new Date(candidate.data.start_at) : null;
  if (!startDatetime && aiClassification?.extracted_start_datetime && datetimeConfidence >= 0.7) {
    try {
      startDatetime = new Date(aiClassification.extracted_start_datetime);
    } catch { /* ignore parse errors */ }
  }
  
  // Determine end_datetime: use candidate data first, then AI-extracted (if confidence >= 0.7)
  let endDatetime = candidate.data.end_at ? new Date(candidate.data.end_at) : null;
  if (!endDatetime && aiClassification?.extracted_end_datetime && datetimeConfidence >= 0.7) {
    try {
      endDatetime = new Date(aiClassification.extracted_end_datetime);
    } catch { /* ignore parse errors */ }
  }
  
  // Determine location: use candidate data first, then AI-extracted (if confidence >= 0.7)
  let locationAddress = candidate.data.address || null;
  let locationDistrict: string | null = null;
  if (!locationAddress && aiClassification?.extracted_location_address && locationConfidence >= 0.7) {
    locationAddress = aiClassification.extracted_location_address;
    locationDistrict = aiClassification.extracted_location_district || null;
  }
  
  // Determine venue_name: candidate first, then AI
  let venueNameResolved = candidate.data.venue_name || null;
  let cityResolved = candidate.data.city || null;
  let postalCodeResolved = candidate.data.postal_code || null;
  
  if (aiClassification?.extracted_venue_name && (aiClassification.venue_confidence ?? 0) >= 0.7) {
    if (!venueNameResolved) venueNameResolved = aiClassification.extracted_venue_name;
    if (!locationAddress && aiClassification.extracted_address_line) {
      locationAddress = aiClassification.extracted_address_line;
    }
    if (!cityResolved && aiClassification.extracted_city) {
      cityResolved = aiClassification.extracted_city;
    }
    if (!postalCodeResolved && aiClassification.extracted_postal_code) {
      postalCodeResolved = aiClassification.extracted_postal_code;
    }
  }
  
  // Determine price: candidate data first, then AI (use == null, NOT falsy -- price_min 0 is valid!)
  let priceType = sanitizePriceType(candidate.data.price_type);
  let priceMin: number | null = candidate.data.price_min ?? null;
  let priceMax: number | null = candidate.data.price_max ?? null;
  
  // Derive price_type from price_min if not explicitly set
  if (priceType === 'unknown' && priceMin != null) {
    priceType = priceMin === 0 ? 'free' : 'paid';
  }
  
  // AI-extracted price (only if normalizer didn't detect it -- use == null!)
  if (priceMin == null && aiClassification?.extracted_price_type && (aiClassification.price_confidence ?? 0) >= 0.7) {
    if (aiClassification.extracted_price_type === 'free' || aiClassification.extracted_price_type === 'donation') {
      priceType = aiClassification.extracted_price_type === 'donation' ? 'free' : 'free';
      priceMin = 0;
    } else if (aiClassification.extracted_price_min != null) {
      priceType = 'paid';
      priceMin = aiClassification.extracted_price_min;
      if (aiClassification.extracted_price_max != null) priceMax = aiClassification.extracted_price_max;
    }
  }
  
  // Determine availability_status (from data or AI)
  let availabilityStatus = candidate.data.availability_status || null;
  if (!availabilityStatus && aiClassification?.is_cancelled_or_postponed) {
    availabilityStatus = 'cancelled';
  }
  
  const eventData = {
    title: candidate.data.title,
    description_short: candidate.data.description?.substring(0, 500) || null,
    description_long: candidate.data.description || null,
    start_datetime: startDatetime,
    end_datetime: endDatetime,
    timezone_original: candidate.data.timezone_original || null,
    location_address: locationAddress,
    location_district: locationDistrict,
    location_lat: candidate.data.lat || candidate.ai?.geocode?.lat || null,
    location_lng: candidate.data.lng || candidate.ai?.geocode?.lng || null,
    venue_name: venueNameResolved,
    city: cityResolved || 'Karlsruhe',
    postal_code: postalCodeResolved,
    country_code: candidate.data.country_code || 'DE',
    price_min: priceMin,
    price_max: priceMax,
    price_type: priceType as any,
    price_details: candidate.data.price_details ? (candidate.data.price_details as Prisma.InputJsonValue) : undefined,
    age_min: candidate.data.age_min || aiClassification?.age_min || null,
    age_max: candidate.data.age_max || aiClassification?.age_max || null,
    is_indoor: candidate.data.is_indoor || aiClassification?.is_indoor || false,
    is_outdoor: candidate.data.is_outdoor || aiClassification?.is_outdoor || false,
    booking_url: candidate.data.booking_url || null,
    contact_email: candidate.data.contact_email || null,
    contact_phone: candidate.data.contact_phone || null,
    image_urls: candidate.data.images || [],
    // Extended AI fields
    age_recommendation_text: candidate.data.age_recommendation_text || aiClassification?.age_recommendation_text || null,
    sibling_friendly: candidate.data.sibling_friendly ?? aiClassification?.sibling_friendly ?? null,
    language: candidate.data.language || aiClassification?.language || null,
    complexity_level: candidate.data.complexity_level || aiClassification?.complexity_level || null,
    noise_level: candidate.data.noise_level || aiClassification?.noise_level || null,
    has_seating: candidate.data.has_seating ?? aiClassification?.has_seating ?? null,
    typical_wait_minutes: candidate.data.typical_wait_minutes || aiClassification?.typical_wait_minutes || null,
    food_drink_allowed: candidate.data.food_drink_allowed ?? aiClassification?.food_drink_allowed ?? null,
    // Recurrence / Availability
    recurrence_rule: candidate.data.recurrence_rule || null,
    availability_status: availabilityStatus,
    // AI-generated summaries
    ai_summary_short: aiClassification?.ai_summary_short || null,
    ai_summary_highlights: aiClassification?.ai_summary_highlights?.length ? aiClassification.ai_summary_highlights : [],
    ai_fit_blurb: aiClassification?.ai_fit_blurb || null,
    ai_summary_confidence: aiClassification?.summary_confidence ?? null,
  };
  
  const completeness = calculateCompleteness(eventData);
  
  // Determine status based on AI scores if available, otherwise use completeness
  let initialStatus: string;
  if (candidate.ai?.scores && candidate.ai?.classification) {
    const aiScores: AIScoreInput = {
      family_fit: candidate.ai.scores.family_fit,
      confidence: candidate.ai.classification.confidence,
    };
    initialStatus = determineStatusFromAI(completeness, aiScores);
  } else {
    // No AI scores: ALL events go to AI processing regardless of completeness
    // AI will extract missing data (datetime, location) from description
    initialStatus = 'pending_ai';
  }
  
  // Build initial provenance
  const initialProvenance: Record<string, string> = {};
  const initialFieldUpdatedAt: Record<string, string> = {};
  
  // Track which fields came from AI vs feed/normalizer
  const aiExtractedFields = new Set<string>();
  if (aiClassification) {
    if ((aiClassification.venue_confidence ?? 0) >= 0.7) {
      if (!candidate.data.venue_name && aiClassification.extracted_venue_name) aiExtractedFields.add('venue_name');
      if (!candidate.data.address && aiClassification.extracted_address_line) aiExtractedFields.add('location_address');
      if (!candidate.data.city && aiClassification.extracted_city) aiExtractedFields.add('city');
      if (!candidate.data.postal_code && aiClassification.extracted_postal_code) aiExtractedFields.add('postal_code');
    }
    if ((aiClassification.price_confidence ?? 0) >= 0.7 && candidate.data.price_min == null) {
      aiExtractedFields.add('price_min');
      aiExtractedFields.add('price_type');
    }
    if ((aiClassification.datetime_confidence ?? 0) >= 0.7) {
      if (!candidate.data.start_at && aiClassification.extracted_start_datetime) aiExtractedFields.add('start_datetime');
      if (!candidate.data.end_at && aiClassification.extracted_end_datetime) aiExtractedFields.add('end_datetime');
    }
    if (aiClassification.extracted_location_address && !candidate.data.address) aiExtractedFields.add('location_address');
  }
  
  for (const [key, value] of Object.entries(eventData)) {
    if (value !== null && value !== undefined && value !== '' && 
        !(Array.isArray(value) && value.length === 0)) {
      const fieldSource = aiExtractedFields.has(key) ? 'ai' : sourceType;
      initialProvenance[key] = fieldSource;
      initialFieldUpdatedAt[key] = nowIso;
      appliedFields.push(key);
    }
  }
  
  const initialFieldFillStatus = buildFieldFillStatus(eventData, initialProvenance, nowIso);
  
  // Enrich field_fill_status with AI confidence where applicable
  if (aiClassification) {
    for (const field of aiExtractedFields) {
      if (initialFieldFillStatus[field]) {
        let confidence = 1.0;
        if (['venue_name', 'location_address', 'city', 'postal_code'].includes(field)) {
          confidence = aiClassification.venue_confidence ?? 0.7;
        } else if (['price_min', 'price_type'].includes(field)) {
          confidence = aiClassification.price_confidence ?? 0.7;
        } else if (['start_datetime', 'end_datetime'].includes(field)) {
          confidence = aiClassification.datetime_confidence ?? 0.7;
        }
        initialFieldFillStatus[field].confidence = confidence;
      }
    }
  }
  
  const newEvent = await prisma.canonicalEvent.create({
    data: {
      ...eventData,
      status: initialStatus as EventStatus,
      is_complete: completeness.isComplete,
      completeness_score: completeness.score,
      field_provenance: initialProvenance,
      field_updated_at: initialFieldUpdatedAt,
      field_fill_status: initialFieldFillStatus,
    }
  });
  
  // Create EventSource (Verbindung Quelle <-> Event für Pending-AI-Zählung pro Quelle)
  const eventSource = await prisma.eventSource.create({
    data: {
      canonical_event_id: newEvent.id,
      source_id: sourceId,
      external_id: candidate.external_id || null,
      source_url: candidate.source_url,
      fingerprint: candidate.fingerprint,
      raw_data: candidate.data as any,
      normalized_data: candidate.data as any,
    }
  });

  await prisma.canonicalEvent.update({
    where: { id: newEvent.id },
    data: { primary_source_id: eventSource.id },
  });
  
  // Update RawEventItem
  await prisma.rawEventItem.update({
    where: { id: rawEventItem.id },
    data: {
      canonical_event_id: newEvent.id,
      ingest_status: 'created',
      ingest_result: {
        applied_fields: appliedFields,
        ignored_fields: [],
        merge_reasons: [],
      } as any,
    }
  });
  
  // Handle categories
  if (candidate.data.categories?.length || candidate.ai?.classification?.categories?.length) {
    const categorySlugs = candidate.data.categories || candidate.ai?.classification?.categories || [];
    const categories = await prisma.category.findMany({
      where: { slug: { in: categorySlugs } }
    });
    
    for (const cat of categories) {
      await prisma.eventCategory.create({
        data: {
          event_id: newEvent.id,
          category_id: cat.id,
        }
      }).catch(() => {}); // Ignore if exists
    }
  }
  
  // Handle AI scores
  if (candidate.ai?.scores) {
    await prisma.eventScore.create({
      data: {
        event_id: newEvent.id,
        relevance_score: candidate.ai.scores.relevance,
        quality_score: candidate.ai.scores.quality,
        family_fit_score: candidate.ai.scores.family_fit,
        stressfree_score: candidate.ai.scores.stressfree || null,
        confidence: candidate.ai.classification?.confidence ?? 0.8,
        ai_model_version: 'worker-v1',
      }
    }).catch(() => {}); // Ignore if exists
  }
  
  return {
    fingerprint: candidate.fingerprint,
    status: 'created',
    event_id: newEvent.id,
    raw_item_id: rawEventItem.id,
    applied_fields: appliedFields,
    ignored_fields: [],
    merge_reasons: [],
  };
}

/**
 * Process a batch of candidates
 */
export async function processBatch(
  candidates: CanonicalCandidate[],
  sourceId: string,
  runId: string
): Promise<{
  results: IngestItemResult[];
  summary: {
    created: number;
    updated: number;
    unchanged: number;
    ignored: number;
  };
}> {
  const results: IngestItemResult[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let ignored = 0;
  
  for (const candidate of candidates) {
    try {
      const result = await processSingleCandidate(candidate, sourceId, runId);
      results.push(result);
      
      switch (result.status) {
        case 'created': created++; break;
        case 'updated': updated++; break;
        case 'unchanged': unchanged++; break;
        case 'ignored': ignored++; break;
      }
    } catch (error) {
      console.error(`Failed to process candidate ${candidate.fingerprint}:`, error);
      results.push({
        fingerprint: candidate.fingerprint,
        status: 'ignored',
        applied_fields: [],
        ignored_fields: [],
        merge_reasons: [{
          field: '*',
          reason: 'locked',
          current_source: 'error',
          candidate_source: (error as Error).message,
        }],
      });
      ignored++;
    }
  }
  
  // Update IngestRun with statistics
  const topReasons = aggregateMergeReasons(results);
  // #region agent log
  const _updateData = { events_found: candidates.length, events_created: created, events_updated: updated, events_unchanged: unchanged, events_ignored: ignored, status: ignored === candidates.length ? 'failed' : (ignored > 0 ? 'partial' : 'success') };
  fetch('http://127.0.0.1:7245/ingest/5d9bb467-7a30-458e-a7a6-30ea6b541c63', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'merge.ts:processBatch_before_update', message: 'updating IngestRun (per-batch overwrite)', data: { runId, batch_candidates_length: candidates.length, ..._updateData }, timestamp: Date.now(), hypothesisId: 'H3' }) }).catch(() => {});
  // #endregion
  await prisma.ingestRun.update({
    where: { id: runId },
    data: {
      events_found: candidates.length,
      events_created: created,
      events_updated: updated,
      events_unchanged: unchanged,
      events_ignored: ignored,
      merge_stats: { top_reasons: topReasons } as any,
      status: ignored === candidates.length ? 'failed' : (ignored > 0 ? 'partial' : 'success'),
      finished_at: new Date(),
    }
  });
  
  return {
    results,
    summary: { created, updated, unchanged, ignored },
  };
}

/**
 * Aggregate merge reasons for reporting
 */
function aggregateMergeReasons(results: IngestItemResult[]): Array<{ reason: string; count: number }> {
  const reasonCounts: Record<string, number> = {};
  
  for (const result of results) {
    for (const mr of result.merge_reasons) {
      const key = mr.reason;
      reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    }
  }
  
  return Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}
