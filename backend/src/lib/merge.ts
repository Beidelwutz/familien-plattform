/**
 * Merge logic for batch ingest with field-level provenance tracking.
 * Implements Option A: Backend makes all final merge decisions.
 */

import { prisma } from './prisma.js';
import { SOURCE_PRIORITY, computeFingerprint } from './idempotency.js';
import { calculateCompleteness, determineInitialStatus, determineStatusFromAI, type AIScoreInput } from './eventCompleteness.js';

// Staleness threshold in days
const STALENESS_DAYS = 180;

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
    start_at: string;
    end_at?: string;
    timezone_original?: string;
    venue_name?: string;
    address?: string;
    lat?: number;
    lng?: number;
    price_min?: number;
    price_max?: number;
    age_min?: number;
    age_max?: number;
    categories?: string[];
    images?: string[];
    booking_url?: string;
    contact_email?: string;
    contact_phone?: string;
    is_indoor?: boolean;
    is_outdoor?: boolean;
  };
  
  ai?: {
    classification?: {
      categories: string[];
      age_min?: number;
      age_max?: number;
      is_indoor?: boolean;
      is_outdoor?: boolean;
      confidence: number;
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
    ];
    
    // Apply AI suggestions if available
    if (candidate.ai?.classification) {
      const ai = candidate.ai.classification;
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
      // Apply updates
      await prisma.canonicalEvent.update({
        where: { id: existingEvent.id },
        data: {
          ...updates,
          field_provenance: newProvenance,
          field_updated_at: newFieldUpdatedAt,
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
  const eventData = {
    title: candidate.data.title,
    description_short: candidate.data.description?.substring(0, 500) || null,
    description_long: candidate.data.description || null,
    start_datetime: new Date(candidate.data.start_at),
    end_datetime: candidate.data.end_at ? new Date(candidate.data.end_at) : null,
    timezone_original: candidate.data.timezone_original || null,
    location_address: candidate.data.address || null,
    location_lat: candidate.data.lat || candidate.ai?.geocode?.lat || null,
    location_lng: candidate.data.lng || candidate.ai?.geocode?.lng || null,
    price_min: candidate.data.price_min || null,
    price_max: candidate.data.price_max || null,
    price_type: candidate.data.price_min ? (candidate.data.price_min === 0 ? 'free' : 'paid') : 'unknown' as any,
    age_min: candidate.data.age_min || candidate.ai?.classification?.age_min || null,
    age_max: candidate.data.age_max || candidate.ai?.classification?.age_max || null,
    is_indoor: candidate.data.is_indoor || candidate.ai?.classification?.is_indoor || false,
    is_outdoor: candidate.data.is_outdoor || candidate.ai?.classification?.is_outdoor || false,
    booking_url: candidate.data.booking_url || null,
    contact_email: candidate.data.contact_email || null,
    contact_phone: candidate.data.contact_phone || null,
    image_urls: candidate.data.images || [],
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
    // No AI scores: set to pending_ai for later processing
    initialStatus = completeness.score >= 50 ? 'pending_ai' : 'incomplete';
  }
  
  // Build initial provenance
  const initialProvenance: Record<string, string> = {};
  const initialFieldUpdatedAt: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(eventData)) {
    if (value !== null && value !== undefined && value !== '' && 
        !(Array.isArray(value) && value.length === 0)) {
      initialProvenance[key] = sourceType;
      initialFieldUpdatedAt[key] = nowIso;
      appliedFields.push(key);
    }
  }
  
  const newEvent = await prisma.canonicalEvent.create({
    data: {
      ...eventData,
      status: initialStatus,
      is_complete: completeness.isComplete,
      completeness_score: completeness.score,
      field_provenance: initialProvenance,
      field_updated_at: initialFieldUpdatedAt,
    }
  });
  
  // Create EventSource
  await prisma.eventSource.create({
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
