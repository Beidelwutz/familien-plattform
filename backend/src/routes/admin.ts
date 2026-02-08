import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin, requireServiceToken, type AuthRequest } from '../middleware/auth.js';
import { approveRevision, rejectRevision } from '../lib/eventRevision.js';
import { sendEventApprovedEmail, sendEventRejectedEmail } from '../lib/email.js';
import { AI_THRESHOLDS, calculateCompleteness } from '../lib/eventCompleteness.js';
import { canPublish } from '../lib/eventQuery.js';
import { logger } from '../lib/logger.js';
import { redis, isRedisAvailable } from '../lib/redis.js';
import { logAdminAction, AuditAction } from '../lib/adminAudit.js';

const AI_WORKER_URL = process.env.AI_WORKER_URL || 'http://localhost:5000';

/** User-friendly message when AI Worker returns 404 (wrong URL or not deployed). */
function normalizeAIWorker404Message(rawMessage: string): string {
  if (String(rawMessage).includes('404') && (String(rawMessage).includes('Application not found') || String(rawMessage).includes('Not Found'))) {
    return 'AI Worker nicht erreichbar (404). Bitte AI_WORKER_URL prüfen und AI Worker starten (z.B. ai-worker/start.bat oder Deployment auf Railway).';
  }
  return rawMessage;
}

// #region agent log
const _debugLog = (data: Record<string, unknown>) => {
  const payload = { ...data, timestamp: Date.now(), sessionId: 'debug-session' };
  logger.info('[BATCH-DEBUG] ' + JSON.stringify(payload));
  (async () => {
    try {
      const { appendFileSync, mkdirSync } = await import('fs');
      const { dirname, join } = await import('path');
      const logPath = join(process.cwd(), '..', '.cursor', 'debug.log');
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, JSON.stringify(payload) + '\n');
    } catch (_) { /* ignore */ }
  })();
  fetch('http://127.0.0.1:7245/ingest/5d9bb467-7a30-458e-a7a6-30ea6b541c63', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
};
// #endregion

const router = Router();

// PATCH /api/admin/ingest-runs/:id - Update ingest run (called by AI-Worker with SERVICE_TOKEN)
// Must be registered BEFORE router.use(requireAuth, requireAdmin) so it accepts Bearer SERVICE_TOKEN
router.patch('/ingest-runs/:id', requireServiceToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const {
      status,
      events_found,
      events_created,
      events_updated,
      events_skipped,
      error_message,
      error_details,
      needs_attention,
      finished_at,
    } = req.body;

    const updateData: Record<string, any> = {};
    if (status !== undefined) updateData.status = status;
    if (events_found !== undefined) updateData.events_found = events_found;
    if (events_created !== undefined) updateData.events_created = events_created;
    if (events_updated !== undefined) updateData.events_updated = events_updated;
    if (events_skipped !== undefined) updateData.events_skipped = events_skipped;
    if (error_message !== undefined) updateData.error_message = error_message;
    if (error_details !== undefined) updateData.error_details = error_details;
    if (needs_attention !== undefined) updateData.needs_attention = needs_attention;
    if (finished_at === 'now') {
      updateData.finished_at = new Date();
    } else if (finished_at) {
      updateData.finished_at = new Date(finished_at);
    }
    if (['success', 'partial', 'failed'].includes(status) && !updateData.finished_at) {
      updateData.finished_at = new Date();
    }
    if (status === 'failed' && needs_attention === undefined) {
      updateData.needs_attention = true;
    }

    const run = await prisma.ingestRun.update({
      where: { id },
      data: updateData,
      include: { source: { select: { id: true, name: true } } }
    });

    if (run.source_id && ['success', 'partial', 'failed'].includes(status)) {
      const sourceUpdate: Record<string, any> = {};
      if (status === 'success') {
        sourceUpdate.last_success_at = new Date();
        sourceUpdate.consecutive_failures = 0;
        sourceUpdate.health_status = 'healthy';
        if (events_found !== undefined) {
          const source = await prisma.source.findUnique({ where: { id: run.source_id } });
          if (source) {
            const currentAvg = source.avg_events_per_fetch || 0;
            sourceUpdate.avg_events_per_fetch = currentAvg === 0 ? events_found : (currentAvg * 0.7 + events_found * 0.3);
          }
        }
      } else if (status === 'failed') {
        sourceUpdate.last_failure_at = new Date();
        const source = await prisma.source.findUnique({ where: { id: run.source_id } });
        if (source) {
          const failures = (source.consecutive_failures || 0) + 1;
          sourceUpdate.consecutive_failures = failures;
          sourceUpdate.health_status = failures >= 5 ? 'dead' : failures >= 3 ? 'failing' : 'degraded';
        }
      } else if (status === 'partial') {
        sourceUpdate.last_success_at = new Date();
        sourceUpdate.health_status = 'degraded';
      }
      if (Object.keys(sourceUpdate).length > 0) {
        await prisma.source.update({ where: { id: run.source_id }, data: sourceUpdate });
      }
    }

    res.json({ success: true, message: 'Ingest run updated', data: run });
  } catch (error) {
    next(error);
  }
});

// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);

// GET /api/admin/stats - Dashboard statistics
router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [
      totalEvents,
      publishedEvents,
      pendingReview,
      pendingAi,
      rejectedEvents,
      todayImports,
      sources,
      // AI-processed stats: Events with scores (meaning AI processed them)
      aiProcessedWithScores
    ] = await Promise.all([
      prisma.canonicalEvent.count(),
      prisma.canonicalEvent.count({ where: { status: 'published' } }),
      prisma.canonicalEvent.count({ where: { status: 'pending_review' } }),
      prisma.canonicalEvent.count({ where: { status: 'pending_ai' } }),
      prisma.canonicalEvent.count({ where: { status: 'rejected' } }),
      prisma.canonicalEvent.count({
        where: {
          created_at: {
            gte: new Date(new Date().setHours(0, 0, 0, 0))
          }
        }
      }),
      prisma.source.groupBy({
        by: ['health_status'],
        _count: true
      }),
      // Get AI-processed events (events that have scores)
      prisma.eventScore.count()
    ]);

    // Get AI-published count (published events with scores = AI auto-published)
    const aiPublished = await prisma.canonicalEvent.count({
      where: {
        status: 'published',
        scores: { isNot: null }
      }
    });

    // Get AI-rejected count (rejected events with low family_fit_score)
    const aiRejected = await prisma.canonicalEvent.count({
      where: {
        status: 'rejected',
        scores: {
          family_fit_score: { lt: 30 }
        }
      }
    });

    const sourceHealth = {
      healthy: 0,
      degraded: 0,
      failing: 0,
      dead: 0,
      unknown: 0
    };

    sources.forEach((s: any) => {
      sourceHealth[s.health_status as keyof typeof sourceHealth] = s._count;
    });

    res.json({
      success: true,
      data: {
        events: {
          total: totalEvents,
          published: publishedEvents,
          pending_review: pendingReview,
          pending_ai: pendingAi,
          rejected: rejectedEvents,
          today_imports: todayImports
        },
        ai_stats: {
          total_processed: aiProcessedWithScores,
          ai_published: aiPublished,
          ai_rejected: aiRejected,
          ai_pending_review: aiProcessedWithScores - aiPublished - aiRejected
        },
        sources: sourceHealth
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// REVIEW REASON HELPERS
// ============================================

type ReviewReason = 'LOW_CONFIDENCE' | 'BORDERLINE_FAMILY_FIT' | 'INCOMPLETE' | 'PENDING_AI' | 'NO_SCORES' | 'MANUAL_REVIEW';
type RejectionType = 'AI_REJECTED' | 'MANUAL_REJECTED' | null;

const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
  LOW_CONFIDENCE: 'AI unsicher',
  BORDERLINE_FAMILY_FIT: 'Grenzfall Familie',
  INCOMPLETE: 'Unvollständig',
  PENDING_AI: 'Warte auf AI',
  NO_SCORES: 'Keine Scores',
  MANUAL_REVIEW: 'Manuelle Prüfung',
};

const REJECTION_REASON_LABELS: Record<string, string> = {
  spam: 'Spam / Werbung',
  incomplete: 'Unvollständig',
  wrong_date: 'Falsches Datum',
  duplicate: 'Duplikat',
  not_relevant: 'Nicht relevant',
  other: 'Sonstiges',
};

/**
 * Compute why an event is in the review queue
 */
function computeReviewReason(event: any): { reason: ReviewReason; label: string } {
  if (event.status === 'pending_ai') {
    return { reason: 'PENDING_AI', label: REVIEW_REASON_LABELS.PENDING_AI };
  }
  if (event.status === 'incomplete') {
    return { reason: 'INCOMPLETE', label: REVIEW_REASON_LABELS.INCOMPLETE };
  }
  
  const scores = event.scores;
  if (!scores) {
    return { reason: 'NO_SCORES', label: REVIEW_REASON_LABELS.NO_SCORES };
  }
  
  const confidence = scores.confidence ? Number(scores.confidence) : 0;
  const familyFit = scores.family_fit_score || 0;
  
  if (confidence < 0.8) {
    return { reason: 'LOW_CONFIDENCE', label: REVIEW_REASON_LABELS.LOW_CONFIDENCE };
  }
  if (familyFit >= 30 && familyFit < 50) {
    return { reason: 'BORDERLINE_FAMILY_FIT', label: REVIEW_REASON_LABELS.BORDERLINE_FAMILY_FIT };
  }
  if (event.completeness_score && event.completeness_score < 80) {
    return { reason: 'INCOMPLETE', label: REVIEW_REASON_LABELS.INCOMPLETE };
  }
  
  return { reason: 'MANUAL_REVIEW', label: REVIEW_REASON_LABELS.MANUAL_REVIEW };
}

/**
 * Compute rejection type and label for rejected events
 */
function computeRejectionInfo(event: any): { type: RejectionType; label: string | null } {
  if (event.status !== 'rejected') {
    return { type: null, label: null };
  }
  
  // Check if manually rejected (has cancellation_reason)
  if (event.cancellation_reason) {
    const reasonCode = typeof event.cancellation_reason === 'string' 
      ? event.cancellation_reason 
      : event.cancellation_reason.code || event.cancellation_reason;
    const label = REJECTION_REASON_LABELS[reasonCode] || reasonCode;
    return { type: 'MANUAL_REJECTED', label };
  }
  
  // Check if AI rejected (low family fit score)
  const scores = event.scores;
  if (scores && scores.family_fit_score !== null && scores.family_fit_score < 30) {
    return { 
      type: 'AI_REJECTED', 
      label: `Nicht familiengeeignet (${scores.family_fit_score}%)` 
    };
  }
  
  return { type: 'MANUAL_REJECTED', label: 'Unbekannter Grund' };
}

// GET /api/admin/review-queue - Events pending review
router.get('/review-queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status = 'pending_review', limit = 20, offset = 0 } = req.query;

    const where: any = {};
    
    if (status !== 'all') {
      where.status = status;
    }
    // 'all' = no filter, show all statuses

    const [events, total] = await Promise.all([
      prisma.canonicalEvent.findMany({
        where,
        take: Number(limit),
        skip: Number(offset),
        orderBy: { created_at: 'desc' },
        include: {
          scores: true,
          primary_source: {
            include: {
              source: true
            }
          }
        }
      }),
      prisma.canonicalEvent.count({ where })
    ]);

    // Enrich events with review_reason and rejection_info
    const enrichedEvents = events.map(event => {
      const reviewInfo = computeReviewReason(event);
      const rejectionInfo = computeRejectionInfo(event);
      
      return {
        ...event,
        review_reason: reviewInfo.reason,
        review_reason_label: reviewInfo.label,
        rejection_type: rejectionInfo.type,
        rejection_label: rejectionInfo.label,
      };
    });

    res.json({
      success: true,
      data: enrichedEvents,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/events/:id/raw-data - Raw/import data for an event (for review panel)
router.get('/events/:id/raw-data', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const event = await prisma.canonicalEvent.findUnique({
      where: { id },
      select: { id: true }
    });
    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    const [rawItems, eventSources] = await Promise.all([
      prisma.rawEventItem.findMany({
        where: { canonical_event_id: id },
        orderBy: { fetched_at: 'desc' },
        include: {
          source: { select: { id: true, name: true, type: true, url: true } },
          run: { select: { id: true, started_at: true, status: true } }
        }
      }),
      prisma.eventSource.findMany({
        where: { canonical_event_id: id },
        include: {
          source: { select: { id: true, name: true, type: true, url: true } }
        }
      })
    ]);

    res.json({
      success: true,
      data: {
        raw_event_items: rawItems.map(item => ({
          id: item.id,
          source: item.source,
          run: item.run,
          source_url: item.source_url,
          external_id: item.external_id,
          fingerprint: item.fingerprint,
          fetched_at: item.fetched_at,
          ingest_status: item.ingest_status,
          raw_payload: item.raw_payload,
          extracted_fields: item.extracted_fields,
          ai_suggestions: item.ai_suggestions,
          ingest_result: item.ingest_result
        })),
        event_sources: eventSources.map(es => ({
          id: es.id,
          source: es.source,
          source_url: es.source_url,
          external_id: es.external_id,
          fingerprint: es.fingerprint,
          fetched_at: es.fetched_at,
          raw_data: es.raw_data,
          normalized_data: es.normalized_data
        }))
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/events/:id/source-details - Comprehensive source data for admin detail panel
router.get('/events/:id/source-details', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const include = ((req.query.include as string) || 'meta,provenance').split(',');
    const sourceId = req.query.sourceId as string | undefined;

    // Always fetch the canonical event with full data
    const event = await prisma.canonicalEvent.findUnique({
      where: { id },
      include: {
        scores: true,
        categories: { include: { category: { select: { slug: true, name_de: true } } } },
      }
    });
    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    // Build sources list
    let sources: SourceMeta[] = [];
    if (include.includes('meta') || include.includes('raw_payload')) {
      const includeRaw = include.includes('raw_payload');
      
      // Get EventSources
      const eventSourcesQuery: any = {
        where: sourceId ? { canonical_event_id: id, id: sourceId } : { canonical_event_id: id },
        include: { source: { select: { id: true, name: true, type: true, url: true } } },
        orderBy: { fetched_at: 'desc' as const },
      };
      const eventSources = await prisma.eventSource.findMany(eventSourcesQuery) as any[];
      
      // Get RawEventItems  
      const rawItemsQuery: any = {
        where: sourceId 
          ? { canonical_event_id: id }
          : { canonical_event_id: id },
        include: { source: { select: { id: true, name: true, type: true, url: true } }, run: { select: { id: true, started_at: true, status: true } } },
        orderBy: { fetched_at: 'desc' as const },
      };
      const rawItems = await prisma.rawEventItem.findMany(rawItemsQuery) as any[];

      // Merge into sources list (EventSources first, then RawEventItems for additional data)
      for (const es of eventSources) {
        const normalizedData = es.normalized_data as Record<string, any> | null;
        const rawData = es.raw_data as Record<string, any> | null;
        const fieldsPreview = normalizedData ? Object.keys(normalizedData).filter(k => normalizedData[k] !== null && normalizedData[k] !== '') : [];
        
        sources.push({
          id: es.id,
          source_name: es.source?.name || 'Unbekannt',
          source_type: es.source?.type || 'unknown',
          source_url: es.source_url,
          fetched_at: es.fetched_at.toISOString(),
          field_count: fieldsPreview.length,
          fields_preview: fieldsPreview.slice(0, 15),
          ...(includeRaw ? { raw_payload: rawData, normalized_data: normalizedData } : {}),
        });
      }
      
      // Add RawEventItems that have additional data
      for (const ri of rawItems) {
        const extractedFields = ri.extracted_fields as Record<string, any> | null;
        const fieldsPreview = extractedFields ? Object.keys(extractedFields).filter(k => extractedFields[k] !== null && extractedFields[k] !== '') : [];
        
        // Check if we already have this source (by source_url match)
        const existingSource = sources.find(s => s.source_url === ri.source_url);
        if (existingSource) {
          // Merge extracted_fields into existing source
          if (includeRaw) {
            existingSource.extracted_fields = extractedFields;
            existingSource.raw_payload = existingSource.raw_payload || ri.raw_payload;
          }
          existingSource.field_count = Math.max(existingSource.field_count, fieldsPreview.length);
        } else {
          sources.push({
            id: ri.id,
            source_name: ri.source?.name || 'Unbekannt',
            source_type: ri.source?.type || 'unknown',
            source_url: ri.source_url,
            fetched_at: ri.fetched_at.toISOString(),
            field_count: fieldsPreview.length,
            fields_preview: fieldsPreview.slice(0, 15),
            ...(includeRaw ? { raw_payload: ri.raw_payload, extracted_fields: extractedFields } : {}),
          });
        }
      }
    }

    // Build field conflicts by comparing source values
    const fieldConflicts: Record<string, FieldConflict> = {};
    if (include.includes('conflicts') && sources.length > 1) {
      const fieldValues: Record<string, { source_type: string; source_name: string; value: any; fetched_at: string }[]> = {};
      
      for (const src of sources) {
        const data = src.normalized_data || src.extracted_fields || {};
        if (!data || typeof data !== 'object') continue;
        
        for (const [field, value] of Object.entries(data as Record<string, any>)) {
          if (value === null || value === undefined || value === '') continue;
          if (!fieldValues[field]) fieldValues[field] = [];
          fieldValues[field].push({
            source_type: src.source_type as any,
            source_name: src.source_name,
            value,
            fetched_at: src.fetched_at,
          });
        }
      }
      
      for (const [field, values] of Object.entries(fieldValues)) {
        if (values.length < 2) continue;
        const uniqueValues = new Set(values.map(v => JSON.stringify(v.value)));
        if (uniqueValues.size > 1) {
          const provenance = (event.field_provenance as Record<string, any>) || {};
          fieldConflicts[field] = {
            field,
            values: values as FieldConflict['values'],
            current_winner: provenance[field]?.source || values[0].source_type,
            auto_resolved: !!provenance[field],
          };
        }
      }
    }

    // Build validation checks
    let validationChecks: ValidationCheck[] | undefined;
    if (include.includes('validation')) {
      validationChecks = calculateValidationChecks(event);
    }

    // Build duplicate candidates
    let duplicateCandidates: DuplicateCandidate[] | undefined;
    if (include.includes('duplicates')) {
      const dupCandidates = await prisma.dupCandidate.findMany({
        where: {
          OR: [{ event_a_id: id }, { event_b_id: id }],
        },
        include: {
          event_a: { select: { id: true, title: true, start_datetime: true, location_address: true } },
          event_b: { select: { id: true, title: true, start_datetime: true, location_address: true } },
        },
        take: 20,
      });
      
      duplicateCandidates = dupCandidates.map(dc => {
        const otherEvent = dc.event_a_id === id ? dc.event_b : dc.event_a;
        return {
          event_id: otherEvent.id,
          event_title: otherEvent.title,
          event_date: otherEvent.start_datetime?.toISOString() || null,
          event_location: otherEvent.location_address,
          matching_score: dc.score ? Number(dc.score) : 0,
          confidence: dc.confidence,
          resolution: dc.resolution,
        };
      });
    }

    // Build AI run history from EventRevisions
    let aiRuns: AIRunEntry[] | undefined;
    if (include.includes('ai_runs')) {
      const revisions = await prisma.eventRevision.findMany({
        where: { event_id: id },
        orderBy: { created_at: 'desc' },
        take: 20,
        select: {
          id: true,
          changeset: true,
          created_at: true,
          status: true,
        }
      });
      
      aiRuns = revisions
        .filter(r => {
          const cs = r.changeset as any;
          return cs?.source === 'ai_batch' || cs?.source === 'ai_manual';
        })
        .map(r => {
          const cs = r.changeset as any;
          return {
            id: r.id,
            event_id: id,
            timestamp: r.created_at.toISOString(),
            prompt_version: cs.prompt_version || 'v1',
            model: cs.model || 'gpt-4o-mini',
            input_hash: cs.input_hash || '',
            tokens_input: cs.tokens_input || 0,
            tokens_output: cs.tokens_output || 0,
            cost_usd: cs.cost_usd || 0,
            processing_time_ms: cs.processing_time_ms || 0,
            result_snapshot: cs.changes || null,
            triggered_by: cs.source === 'ai_batch' ? 'batch' as const : 'manual' as const,
          };
        });
    }

    res.json({
      success: true,
      data: {
        canonical_event: {
          id: event.id,
          title: event.title,
          description_short: event.description_short,
          description_long: event.description_long,
          start_datetime: event.start_datetime?.toISOString() || null,
          end_datetime: event.end_datetime?.toISOString() || null,
          is_all_day: event.is_all_day,
          location_address: event.location_address,
          location_district: event.location_district,
          venue_name: event.venue_name,
          city: event.city,
          postal_code: event.postal_code,
          country_code: event.country_code,
          price_type: event.price_type,
          price_min: event.price_min ? Number(event.price_min) : null,
          price_max: event.price_max ? Number(event.price_max) : null,
          price_details: event.price_details,
          age_min: event.age_min,
          age_max: event.age_max,
          age_rating: event.age_rating,
          is_indoor: event.is_indoor,
          is_outdoor: event.is_outdoor,
          booking_url: event.booking_url,
          image_urls: event.image_urls,
          availability_status: event.availability_status,
          recurrence_rule: event.recurrence_rule,
          ai_summary_short: event.ai_summary_short,
          status: event.status,
          completeness_score: event.completeness_score,
          categories: event.categories.map(c => c.category.slug),
          scores: event.scores,
          created_at: event.created_at.toISOString(),
          updated_at: event.updated_at.toISOString(),
        },
        sources,
        field_provenance: (event.field_provenance as Record<string, any>) || {},
        field_fill_status: (event.field_fill_status as Record<string, any>) || {},
        ...(Object.keys(fieldConflicts).length > 0 ? { field_conflicts: fieldConflicts } : {}),
        ...(validationChecks ? { validation_checks: validationChecks } : {}),
        ...(duplicateCandidates ? { duplicate_candidates: duplicateCandidates } : {}),
        ...(aiRuns ? { ai_runs: aiRuns } : {}),
      }
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admin/events/:id/fields - Manual field override with provenance tracking
router.patch('/events/:id/fields', requireAuth, requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { field, value, reason } = req.body;
    const userId = req.user?.sub;

    if (!field || value === undefined) {
      throw createError('field and value are required', 400, 'VALIDATION_ERROR');
    }

    // Allowed fields for manual override
    const allowedFields = [
      'title', 'description_short', 'description_long', 'start_datetime', 'end_datetime',
      'location_address', 'location_district', 'venue_name', 'city', 'postal_code',
      'price_type', 'price_min', 'price_max', 'age_min', 'age_max', 'age_rating',
      'is_indoor', 'is_outdoor', 'booking_url', 'availability_status',
    ];

    if (!allowedFields.includes(field)) {
      throw createError(`Field "${field}" cannot be manually overridden`, 400, 'VALIDATION_ERROR');
    }

    const event = await prisma.canonicalEvent.findUnique({ where: { id } });
    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    const oldValue = (event as any)[field];
    
    // Parse value for special types
    let parsedValue = value;
    if (field === 'start_datetime' || field === 'end_datetime') {
      parsedValue = value ? new Date(value) : null;
    } else if (field === 'price_min' || field === 'price_max') {
      parsedValue = value !== null && value !== '' ? Number(value) : null;
    } else if (field === 'age_min' || field === 'age_max') {
      parsedValue = value !== null && value !== '' ? Number(value) : null;
    } else if (field === 'is_indoor' || field === 'is_outdoor') {
      parsedValue = Boolean(value);
    }

    // Update field_provenance
    const existingProvenance = (event.field_provenance as Record<string, any>) || {};
    existingProvenance[field] = {
      source: 'manual',
      userId,
      at: new Date().toISOString(),
      reason: reason || null,
      previous_value: oldValue,
      previous_source: existingProvenance[field]?.source || null,
    };

    // Update the event
    await prisma.canonicalEvent.update({
      where: { id },
      data: {
        [field]: parsedValue,
        field_provenance: existingProvenance,
      }
    });

    // Create audit log entry via EventRevision
    await prisma.eventRevision.create({
      data: {
        event_id: id,
        changeset: {
          source: 'manual_override',
          user_id: userId,
          field,
          old_value: oldValue,
          new_value: parsedValue,
          reason: reason || null,
        },
        status: 'approved',
      }
    });

    logger.info(`Manual override on event ${id}: ${field} by user ${userId}`);

    res.json({
      success: true,
      data: {
        field,
        old_value: oldValue,
        new_value: parsedValue,
        provenance: existingProvenance[field],
      }
    });
  } catch (error) {
    next(error);
  }
});

// Field fill status: per-field status for missing data and crawl/AI attempts
type FieldFillStatusValue = {
  status: 'filled' | 'missing' | 'crawl_pending' | 'crawl_failed' | 'ai_pending' | 'ai_failed';
  error?: string;
  last_attempt?: string;
  source?: 'feed' | 'crawl' | 'ai' | 'manual';
};

// POST /api/admin/events/:id/trigger-ai - Manually trigger AI (and optional crawl) for one event to fill missing fields
router.post('/events/:id/trigger-ai', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { force_crawl: forceCrawl = false } = req.body || {};
    const nowIso = new Date().toISOString();

    const event = await prisma.canonicalEvent.findUnique({
      where: { id },
      include: {
        event_sources: {
          orderBy: { updated_at: 'desc' as const },
          include: { source: { select: { id: true, detail_page_config: true, url: true } } }
        }
      }
    });
    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    const existingFieldFillStatus = (event.field_fill_status as Record<string, FieldFillStatusValue>) || {};
    const updatedFields: string[] = [];
    const failedFields: Array<{ field: string; reason: string }> = [];

    // Optional: crawl single event URL for missing fields (raw response kept for UI)
    const crawlUrl = event.booking_url || event.event_sources?.[0]?.source_url || null;
    let crawl_raw: { url: string; fields_found: Record<string, unknown>; fields_missing: string[]; extraction_method?: string; error?: string; field_provenance?: Record<string, unknown>; suggested_selectors?: Record<string, unknown> } | null = null;
    if (forceCrawl && crawlUrl) {
      // Find source matching crawl URL domain (not blindly [0])
      let matchedSource: { id: string; detail_page_config: unknown; url: string | null } | null = null;
      try {
        const crawlDomain = new URL(crawlUrl).hostname;
        matchedSource = event.event_sources
          .map(es => es.source)
          .find(s => s?.url && new URL(s.url).hostname === crawlDomain) || null;
      } catch { /* invalid URL, skip matching */ }
      if (!matchedSource) matchedSource = event.event_sources[0]?.source || null;

      const fieldsNeeded: string[] = [];
      if (!event.location_address) fieldsNeeded.push('location_address');
      if (!event.start_datetime) fieldsNeeded.push('start_datetime');
      if (!event.end_datetime) fieldsNeeded.push('end_datetime');
      if (!Array.isArray(event.image_urls) || !event.image_urls.length) fieldsNeeded.push('image_url');

      if (fieldsNeeded.length > 0) {
        try {
          const crawlRes = await fetch(`${AI_WORKER_URL}/crawl/single-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: crawlUrl,
              fields_needed: fieldsNeeded,
              detail_page_config: matchedSource?.detail_page_config || null,
              source_id: matchedSource?.id || null,
            }),
            signal: AbortSignal.timeout(20000),
          });
          const crawlResult = await crawlRes.json() as { success: boolean; fields_found: Record<string, unknown>; fields_missing: string[]; extraction_method?: string; error?: string; field_provenance?: Record<string, unknown>; suggested_selectors?: Record<string, unknown> };
          crawl_raw = {
            url: crawlUrl,
            fields_found: crawlResult.fields_found || {},
            fields_missing: crawlResult.fields_missing || [],
            extraction_method: crawlResult.extraction_method,
            error: crawlResult.error,
            field_provenance: crawlResult.field_provenance || undefined,
            suggested_selectors: crawlResult.suggested_selectors || undefined,
          };
          if (!crawlRes.ok || !crawlResult.success) {
            const errMsg = crawlResult.error || `HTTP ${crawlRes.status}`;
            for (const f of fieldsNeeded) {
              existingFieldFillStatus[f] = { status: 'crawl_failed', error: errMsg, last_attempt: nowIso, source: 'crawl' };
              failedFields.push({ field: f, reason: `Crawl fehlgeschlagen: ${errMsg}` });
            }
          } else {
            const eventUpdate: Record<string, unknown> = {};
            if (crawlResult.fields_found.location_address) {
              eventUpdate.location_address = crawlResult.fields_found.location_address;
              existingFieldFillStatus['location_address'] = { status: 'filled', source: 'crawl', last_attempt: nowIso };
              updatedFields.push('location_address');
            } else if (fieldsNeeded.includes('location_address')) {
              existingFieldFillStatus['location_address'] = { status: 'crawl_failed', error: crawlResult.error || 'Keine Adresse auf der Website gefunden', last_attempt: nowIso, source: 'crawl' };
              failedFields.push({ field: 'location_address', reason: crawlResult.error || 'Keine Adresse auch nach Crawl der Website gefunden' });
            }
            if (crawlResult.fields_found.start_datetime) {
              try {
                eventUpdate.start_datetime = new Date(crawlResult.fields_found.start_datetime as string);
                existingFieldFillStatus['start_datetime'] = { status: 'filled', source: 'crawl', last_attempt: nowIso };
                updatedFields.push('start_datetime');
              } catch { /* ignore */ }
            } else if (fieldsNeeded.includes('start_datetime')) {
              existingFieldFillStatus['start_datetime'] = { status: 'crawl_failed', error: crawlResult.error || 'Kein Datum gefunden', last_attempt: nowIso, source: 'crawl' };
              failedFields.push({ field: 'start_datetime', reason: crawlResult.error || 'Kein Datum auch nach Crawl gefunden' });
            }
            if (crawlResult.fields_found.end_datetime) {
              try {
                eventUpdate.end_datetime = new Date(crawlResult.fields_found.end_datetime as string);
                existingFieldFillStatus['end_datetime'] = { status: 'filled', source: 'crawl', last_attempt: nowIso };
                updatedFields.push('end_datetime');
              } catch { /* ignore */ }
            } else if (fieldsNeeded.includes('end_datetime')) {
              existingFieldFillStatus['end_datetime'] = { status: 'crawl_failed', error: crawlResult.error || 'Kein Enddatum gefunden', last_attempt: nowIso, source: 'crawl' };
              failedFields.push({ field: 'end_datetime', reason: crawlResult.error || 'Kein Enddatum auch nach Crawl gefunden' });
            }
            if (Object.keys(eventUpdate).length > 0) {
              await prisma.canonicalEvent.update({
                where: { id },
                data: { ...eventUpdate, field_fill_status: existingFieldFillStatus }
              });
            }
          }
        } catch (e: any) {
          const errMsg = e?.message || String(e);
          for (const f of fieldsNeeded) {
            existingFieldFillStatus[f] = { status: 'crawl_failed', error: errMsg, last_attempt: nowIso, source: 'crawl' };
            failedFields.push({ field: f, reason: `Crawl fehlgeschlagen: ${errMsg}` });
          }
        }
      }
    }

    // Re-fetch event after optional crawl so AI gets latest data
    let eventForAi = event;
    if (updatedFields.length > 0) {
      const refreshed = await prisma.canonicalEvent.findUnique({ where: { id } });
      if (refreshed) eventForAi = refreshed as typeof event;
    }

    // AI classification + scoring
    const AI_REQUEST_TIMEOUT_MS = 60000;
    let classification: any = null;
    let scores: any = null;
    try {
      const classifyRes = await fetch(`${AI_WORKER_URL}/classify/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: eventForAi.title,
          description: (eventForAi.description_long || eventForAi.description_short || ''),
          location_address: eventForAi.location_address || '',
          price_min: eventForAi.price_min ? Number(eventForAi.price_min) : null,
          price_max: eventForAi.price_max ? Number(eventForAi.price_max) : null,
          is_indoor: eventForAi.is_indoor,
          is_outdoor: eventForAi.is_outdoor,
        }),
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      });
      if (!classifyRes.ok) {
        const errText = await classifyRes.text();
        const friendlyMsg = classifyRes.status === 404
          ? normalizeAIWorker404Message(errText)
          : `Classification: ${classifyRes.status} - ${errText}`;
        throw new Error(friendlyMsg);
      }
      classification = await classifyRes.json();
    } catch (e: any) {
      const errMsg = normalizeAIWorker404Message(e?.message || String(e));
      ['ai_summary_short', 'location_address', 'start_datetime', 'end_datetime'].forEach(f => {
        existingFieldFillStatus[f] = { status: 'ai_failed', error: errMsg, last_attempt: nowIso, source: 'ai' };
        failedFields.push({ field: f, reason: `AI fehlgeschlagen: ${errMsg}` });
      });
      await prisma.canonicalEvent.update({
        where: { id },
        data: { field_fill_status: existingFieldFillStatus }
      });
      return res.json({
        success: false,
        error: errMsg,
        updated_fields: updatedFields,
        failed_fields: failedFields,
        field_fill_status: existingFieldFillStatus,
      });
    }

    try {
      const scoreRes = await fetch(`${AI_WORKER_URL}/classify/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: eventForAi.title,
          description: (eventForAi.description_long || eventForAi.description_short || ''),
          location_address: eventForAi.location_address || '',
        }),
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      });
      if (!scoreRes.ok) {
        const errText = await scoreRes.text();
        const friendlyMsg = scoreRes.status === 404
          ? normalizeAIWorker404Message(errText)
          : `Scoring: ${scoreRes.status} - ${errText}`;
        throw new Error(friendlyMsg);
      }
      scores = await scoreRes.json();
    } catch (e: any) {
      const errMsg = normalizeAIWorker404Message(e?.message || String(e));
      existingFieldFillStatus['ai_summary_short'] = { status: 'ai_failed', error: errMsg, last_attempt: nowIso, source: 'ai' };
      failedFields.push({ field: 'scores', reason: `Scoring fehlgeschlagen: ${errMsg}` });
    }

    const datetimeConfidence = classification?.datetime_confidence || 0;
    const locationConfidence = classification?.location_confidence || 0;
    const updateData: Record<string, any> = {
      age_min: classification?.age_min ?? eventForAi.age_min,
      age_max: classification?.age_max ?? eventForAi.age_max,
      age_rating: classification?.age_rating ?? eventForAi.age_rating,
      is_indoor: classification?.is_indoor ?? eventForAi.is_indoor,
      is_outdoor: classification?.is_outdoor ?? eventForAi.is_outdoor,
      ai_summary_short: classification?.ai_summary_short ?? eventForAi.ai_summary_short,
      ai_summary_highlights: classification?.ai_summary_highlights ?? eventForAi.ai_summary_highlights,
      ai_fit_blurb: classification?.ai_fit_blurb ?? eventForAi.ai_fit_blurb,
      ai_summary_confidence: classification?.summary_confidence ?? eventForAi.ai_summary_confidence,
      age_fit_0_2: classification?.age_fit_buckets?.['0_2'] ?? eventForAi.age_fit_0_2,
      age_fit_3_5: classification?.age_fit_buckets?.['3_5'] ?? eventForAi.age_fit_3_5,
      age_fit_6_9: classification?.age_fit_buckets?.['6_9'] ?? eventForAi.age_fit_6_9,
      age_fit_10_12: classification?.age_fit_buckets?.['10_12'] ?? eventForAi.age_fit_10_12,
      age_fit_13_15: classification?.age_fit_buckets?.['13_15'] ?? eventForAi.age_fit_13_15,
      ai_flags: classification?.flags ?? eventForAi.ai_flags,
      field_fill_status: existingFieldFillStatus,
    };
    if (classification?.ai_summary_short) {
      existingFieldFillStatus['ai_summary_short'] = { status: 'filled', source: 'ai', last_attempt: nowIso };
      updatedFields.push('ai_summary_short');
    } else {
      existingFieldFillStatus['ai_summary_short'] = { status: 'ai_failed', error: 'KI konnte keine Zusammenfassung erzeugen', last_attempt: nowIso, source: 'ai' };
      failedFields.push({ field: 'ai_summary_short', reason: 'Keine KI-Beschreibung erzeugt' });
    }
    if (!eventForAi.location_address && classification?.extracted_location_address && locationConfidence >= 0.7) {
      updateData.location_address = classification.extracted_location_address;
      updateData.location_district = classification.extracted_location_district ?? eventForAi.location_district;
      existingFieldFillStatus['location_address'] = { status: 'filled', source: 'ai', last_attempt: nowIso };
      updatedFields.push('location_address');
    } else if (!eventForAi.location_address) {
      existingFieldFillStatus['location_address'] = { status: 'ai_failed', error: 'Keine Adresse in Beschreibung gefunden', last_attempt: nowIso, source: 'ai' };
      failedFields.push({ field: 'location_address', reason: 'Keine Adresse gefunden, auch nicht in Beschreibung' });
    }
    if (!eventForAi.start_datetime && classification?.extracted_start_datetime && datetimeConfidence >= 0.7) {
      try {
        updateData.start_datetime = new Date(classification.extracted_start_datetime);
        existingFieldFillStatus['start_datetime'] = { status: 'filled', source: 'ai', last_attempt: nowIso };
        updatedFields.push('start_datetime');
      } catch { /* ignore */ }
    } else if (!eventForAi.start_datetime) {
      existingFieldFillStatus['start_datetime'] = { status: 'ai_failed', error: 'Kein Datum/Zeit in Beschreibung gefunden', last_attempt: nowIso, source: 'ai' };
      failedFields.push({ field: 'start_datetime', reason: 'Kein Datum/Zeit gefunden' });
    }
    if (!eventForAi.end_datetime && classification?.extracted_end_datetime && datetimeConfidence >= 0.7) {
      try {
        updateData.end_datetime = new Date(classification.extracted_end_datetime);
        existingFieldFillStatus['end_datetime'] = { status: 'filled', source: 'ai', last_attempt: nowIso };
        updatedFields.push('end_datetime');
      } catch { /* ignore */ }
    } else if (!eventForAi.end_datetime) {
      existingFieldFillStatus['end_datetime'] = { status: 'ai_failed', error: 'Kein Enddatum in Beschreibung gefunden', last_attempt: nowIso, source: 'ai' };
      failedFields.push({ field: 'end_datetime', reason: 'Kein Enddatum gefunden' });
    }

    await prisma.canonicalEvent.update({
      where: { id },
      data: updateData,
    });

    if (scores) {
      await prisma.eventScore.upsert({
        where: { event_id: id },
        create: {
          event_id: id,
          relevance_score: scores.relevance_score,
          quality_score: scores.quality_score,
          family_fit_score: scores.family_fit_score,
          stressfree_score: scores.stressfree_score,
          confidence: classification?.confidence ?? 0.8,
          ai_model_version: 'classify-v1',
        },
        update: {
          relevance_score: scores.relevance_score,
          quality_score: scores.quality_score,
          family_fit_score: scores.family_fit_score,
          stressfree_score: scores.stressfree_score,
          confidence: classification?.confidence ?? 0.8,
          scored_at: new Date(),
        },
      });
    }

    const responsePayload: Record<string, unknown> = {
      success: true,
      updated_fields: updatedFields,
      failed_fields: failedFields,
      field_fill_status: existingFieldFillStatus,
    };
    if (crawl_raw) responsePayload.crawl_raw = crawl_raw;
    return res.json(responsePayload);
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/review/:id/approve - Approve an event
router.post('/review/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    // First fetch the event to validate
    const existingEvent = await prisma.canonicalEvent.findUnique({
      where: { id },
      include: {
        provider: {
          include: {
            user: { select: { email: true } }
          }
        }
      }
    });

    if (!existingEvent) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    // Validate publishability
    const publishCheck = canPublish({
      title: existingEvent.title,
      start_datetime: existingEvent.start_datetime,
      location_address: existingEvent.location_address,
      location_lat: existingEvent.location_lat ? Number(existingEvent.location_lat) : null,
      location_lng: existingEvent.location_lng ? Number(existingEvent.location_lng) : null,
      is_cancelled: existingEvent.is_cancelled,
      age_rating: existingEvent.age_rating,
    });

    if (!publishCheck.valid) {
      throw createError(
        `Kann nicht veröffentlicht werden: ${publishCheck.reason}`,
        400,
        'PUBLISH_VALIDATION_FAILED'
      );
    }

    // Recompute completeness score
    const completeness = calculateCompleteness(existingEvent);

    const event = await prisma.canonicalEvent.update({
      where: { id },
      data: {
        status: 'published',
        is_verified: true,
        is_complete: true,
        last_verified_at: new Date(),
        published_by: 'human_review',
        completeness_score: completeness.score,
      },
      include: {
        provider: {
          include: {
            user: { select: { email: true } }
          }
        }
      }
    });

    // Send event approved notification to provider (non-blocking)
    if (event.provider?.user?.email) {
      // Generate slug from title for the URL
      const eventSlug = event.id; // Using ID as slug for now
      sendEventApprovedEmail(event.provider.user.email, event.title, eventSlug).catch(err => {
        console.error('Failed to send event approved email:', err);
      });
    }

    logger.info(`Event ${id} approved by human review, completeness: ${completeness.score}%`);

    res.json({
      success: true,
      message: 'Event approved',
      data: event
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/review/:id/reject - Reject an event
router.post('/review/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { reason, reason_code } = req.body;

    // Build rejection reason string
    let rejectionReason: string | undefined;
    if (reason_code && reason) {
      rejectionReason = `[${reason_code}] ${reason}`;
    } else if (reason_code) {
      rejectionReason = `[${reason_code}]`;
    } else if (reason) {
      rejectionReason = reason;
    }

    const event = await prisma.canonicalEvent.update({
      where: { id },
      data: {
        status: 'rejected',
        ...(rejectionReason && { cancellation_reason: rejectionReason }),
      },
      include: {
        provider: {
          include: {
            user: { select: { email: true } }
          }
        }
      }
    });

    // Send event rejected notification to provider (non-blocking)
    if (event.provider?.user?.email) {
      sendEventRejectedEmail(event.provider.user.email, event.title, id, reason).catch(err => {
        console.error('Failed to send event rejected email:', err);
      });
    }

    res.json({
      success: true,
      message: 'Event rejected',
      data: event
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/review/:id/quick-edit - Edit and approve in one step
router.post('/review/:id/quick-edit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { title, start_datetime, end_datetime, location_address, locked_fields } = req.body;

    // First fetch the event
    const existingEvent = await prisma.canonicalEvent.findUnique({ where: { id } });
    if (!existingEvent) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    // Merge with updates for validation
    const mergedEvent = {
      title: title ?? existingEvent.title,
      start_datetime: start_datetime ? new Date(start_datetime) : existingEvent.start_datetime,
      location_address: location_address ?? existingEvent.location_address,
      location_lat: existingEvent.location_lat ? Number(existingEvent.location_lat) : null,
      location_lng: existingEvent.location_lng ? Number(existingEvent.location_lng) : null,
      is_cancelled: existingEvent.is_cancelled,
      age_rating: existingEvent.age_rating,
    };

    // Validate publishability
    const publishCheck = canPublish(mergedEvent);
    if (!publishCheck.valid) {
      throw createError(
        `Kann nicht veröffentlicht werden: ${publishCheck.reason}`,
        400,
        'PUBLISH_VALIDATION_FAILED'
      );
    }

    const updateData: any = {
      status: 'published',
      is_verified: true,
      is_complete: true,
      last_verified_at: new Date(),
      published_by: 'human_review',
    };

    // Only update provided fields
    if (title !== undefined) updateData.title = title;
    if (start_datetime !== undefined) updateData.start_datetime = new Date(start_datetime);
    if (end_datetime !== undefined) updateData.end_datetime = new Date(end_datetime);
    if (location_address !== undefined) updateData.location_address = location_address;
    if (locked_fields !== undefined) updateData.locked_fields = locked_fields;

    const event = await prisma.canonicalEvent.update({
      where: { id },
      data: updateData,
    });

    // Recompute completeness after update
    const completeness = calculateCompleteness(event);
    await prisma.canonicalEvent.update({
      where: { id },
      data: { completeness_score: completeness.score }
    });

    logger.info(`Event ${id} quick-edited and approved, completeness: ${completeness.score}%`);

    res.json({
      success: true,
      message: 'Event edited and approved',
      data: { ...event, completeness_score: completeness.score },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/merge-conflicts - Get potential duplicate events
router.get('/merge-conflicts', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Find events with multiple sources
    const eventsWithMultipleSources = await prisma.canonicalEvent.findMany({
      where: {
        event_sources: {
          some: {}
        }
      },
      include: {
        event_sources: {
          include: {
            source: true
          }
        }
      },
      take: 50
    });

    // Filter to only those with actual conflicts
    const conflicts = eventsWithMultipleSources.filter((e: { event_sources: unknown[] }) =>
      e.event_sources.length > 1
    );

    res.json({
      success: true,
      data: conflicts,
      total: conflicts.length
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/merge - Merge two events
router.post('/merge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { primary_id, secondary_id } = req.body;

    if (!primary_id || !secondary_id) {
      throw createError('Both primary_id and secondary_id required', 400, 'VALIDATION_ERROR');
    }

    // Get both events
    const [primary, secondary] = await Promise.all([
      prisma.canonicalEvent.findUnique({ 
        where: { id: primary_id },
        include: { event_sources: true }
      }),
      prisma.canonicalEvent.findUnique({ 
        where: { id: secondary_id },
        include: { event_sources: true }
      })
    ]);

    if (!primary || !secondary) {
      throw createError('One or both events not found', 404, 'NOT_FOUND');
    }

    // Move secondary's sources to primary
    await prisma.eventSource.updateMany({
      where: { canonical_event_id: secondary_id },
      data: { canonical_event_id: primary_id }
    });

    // Update merged_from array
    const mergedFrom = [
      ...(primary.merged_from as string[] || []),
      secondary_id,
      ...(secondary.merged_from as string[] || [])
    ];

    await prisma.canonicalEvent.update({
      where: { id: primary_id },
      data: { merged_from: mergedFrom }
    });

    // Archive secondary
    await prisma.canonicalEvent.update({
      where: { id: secondary_id },
      data: { status: 'archived' }
    });

    res.json({
      success: true,
      message: 'Events merged successfully',
      data: {
        primary_id,
        merged_secondary_id: secondary_id
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// REVISIONS
// ============================================

// GET /api/admin/revisions - List pending revisions
router.get('/revisions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status = 'pending', limit = 20, offset = 0 } = req.query;

    const where: any = {};
    if (status !== 'all') {
      where.status = status;
    }

    const [revisions, total] = await Promise.all([
      prisma.eventRevision.findMany({
        where,
        take: Number(limit),
        skip: Number(offset),
        orderBy: { created_at: 'desc' },
        include: {
          event: {
            select: {
              id: true,
              title: true,
              status: true,
            }
          },
          created_by_user: {
            select: { id: true, email: true }
          }
        }
      }),
      prisma.eventRevision.count({ where })
    ]);

    res.json({
      success: true,
      data: revisions,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/revisions/:id - Get single revision with changeset details
router.get('/revisions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const revision = await prisma.eventRevision.findUnique({
      where: { id },
      include: {
        event: true,
        created_by_user: {
          select: { id: true, email: true }
        },
        reviewed_by_user: {
          select: { id: true, email: true }
        }
      }
    });

    if (!revision) {
      throw createError('Revision not found', 404, 'NOT_FOUND');
    }

    res.json({
      success: true,
      data: revision
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/revisions/:id/approve - Approve a revision
router.post('/revisions/:id/approve', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const userId = req.user?.sub;

    if (!userId) {
      throw createError('User ID required', 400, 'VALIDATION_ERROR');
    }

    const result = await approveRevision(id, userId, note);

    res.json({
      success: true,
      message: 'Revision approved and applied',
      data: result
    });
  } catch (error: any) {
    if (error.message === 'Revision not found') {
      next(createError('Revision not found', 404, 'NOT_FOUND'));
    } else {
      next(error);
    }
  }
});

// POST /api/admin/revisions/:id/reject - Reject a revision
router.post('/revisions/:id/reject', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const userId = req.user?.sub;

    if (!userId) {
      throw createError('User ID required', 400, 'VALIDATION_ERROR');
    }

    await rejectRevision(id, userId, note);

    res.json({
      success: true,
      message: 'Revision rejected'
    });
  } catch (error: any) {
    if (error.message === 'Revision not found') {
      next(createError('Revision not found', 404, 'NOT_FOUND'));
    } else {
      next(error);
    }
  }
});

// ============================================
// DUPLICATE CANDIDATES
// ============================================

// GET /api/admin/duplicates - List duplicate candidates
router.get('/duplicates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status = 'pending', limit = 20, offset = 0 } = req.query;

    const where: any = {};
    if (status === 'pending') {
      where.resolution = null;
    } else if (status !== 'all') {
      where.resolution = status;
    }

    const [duplicates, total] = await Promise.all([
      prisma.dupCandidate.findMany({
        where,
        take: Number(limit),
        skip: Number(offset),
        orderBy: [
          { confidence: 'asc' }, // exact first
          { detected_at: 'desc' }
        ],
        include: {
          event_a: {
            select: {
              id: true,
              title: true,
              start_datetime: true,
              location_address: true,
            }
          },
          event_b: {
            select: {
              id: true,
              title: true,
              start_datetime: true,
              location_address: true,
            }
          }
        }
      }),
      prisma.dupCandidate.count({ where })
    ]);

    res.json({
      success: true,
      data: duplicates,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset)
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/duplicates/:id/merge - Merge duplicate (use event_a as primary)
router.post('/duplicates/:id/merge', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const userId = req.user?.sub;

    const dup = await prisma.dupCandidate.findUnique({
      where: { id },
      include: { event_a: true, event_b: true }
    });

    if (!dup) {
      throw createError('Duplicate candidate not found', 404, 'NOT_FOUND');
    }

    // Move event_b's sources to event_a
    await prisma.eventSource.updateMany({
      where: { canonical_event_id: dup.event_b_id },
      data: { canonical_event_id: dup.event_a_id }
    });

    // Archive event_b
    await prisma.canonicalEvent.update({
      where: { id: dup.event_b_id },
      data: { status: 'archived' }
    });

    // Mark duplicate as resolved
    await prisma.dupCandidate.update({
      where: { id },
      data: {
        resolution: 'merged',
        resolved_at: new Date(),
        resolved_by: userId,
      }
    });

    res.json({
      success: true,
      message: 'Events merged',
      data: {
        primary_event_id: dup.event_a_id,
        archived_event_id: dup.event_b_id,
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/duplicates/:id/mark-different - Mark as not duplicate
router.post('/duplicates/:id/mark-different', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const userId = req.user?.sub;

    await prisma.dupCandidate.update({
      where: { id },
      data: {
        resolution: 'different',
        resolved_at: new Date(),
        resolved_by: userId,
      }
    });

    res.json({
      success: true,
      message: 'Marked as different events'
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/duplicates/:id/ignore - Ignore duplicate
router.post('/duplicates/:id/ignore', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const userId = req.user?.sub;

    await prisma.dupCandidate.update({
      where: { id },
      data: {
        resolution: 'ignored',
        resolved_at: new Date(),
        resolved_by: userId,
      }
    });

    res.json({
      success: true,
      message: 'Duplicate ignored'
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// INGEST RUNS (Observability)
// ============================================

// GET /api/admin/ingest-runs/active - Get all currently running fetches
router.get('/ingest-runs/active', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const activeRuns = await prisma.ingestRun.findMany({
      where: { status: 'running' },
      include: { 
        source: { 
          select: { id: true, name: true, type: true } 
        } 
      },
      orderBy: { started_at: 'desc' }
    });

    // Calculate elapsed time for each run
    const now = new Date();
    const enrichedRuns = activeRuns.map(run => ({
      ...run,
      elapsed_seconds: Math.floor((now.getTime() - new Date(run.started_at).getTime()) / 1000),
    }));

    res.json({
      success: true,
      data: enrichedRuns,
      count: enrichedRuns.length
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/ingest-runs - List ingest runs
router.get('/ingest-runs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, needs_attention, source_id, limit = 20, offset = 0 } = req.query;

    const where: any = {};
    if (status) where.status = status;
    if (needs_attention === 'true') where.needs_attention = true;
    if (source_id) where.source_id = source_id;

    const [runs, total] = await Promise.all([
      prisma.ingestRun.findMany({
        where,
        take: Number(limit),
        skip: Number(offset),
        orderBy: { started_at: 'desc' },
        include: {
          source: {
            select: { id: true, name: true, type: true }
          }
        }
      }),
      prisma.ingestRun.count({ where })
    ]);

    res.json({
      success: true,
      data: runs,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/ingest-runs/needs-attention - Get runs needing attention
router.get('/ingest-runs/needs-attention', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const runs = await prisma.ingestRun.findMany({
      where: { needs_attention: true },
      orderBy: { started_at: 'desc' },
      include: {
        source: {
          select: { id: true, name: true, type: true }
        }
      }
    });

    res.json({
      success: true,
      data: runs,
      total: runs.length
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/ingest-runs/:id/acknowledge - Acknowledge a failed run
router.post('/ingest-runs/:id/acknowledge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    await prisma.ingestRun.update({
      where: { id },
      data: { 
        needs_attention: false,
        acknowledged_at: new Date(),
      }
    });

    res.json({
      success: true,
      message: 'Run acknowledged'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/ingest-runs/stats - Get aggregated statistics
router.get('/ingest-runs/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Get stats for last 24 hours
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const [
      totalRuns,
      successRuns,
      failedRuns,
      totalCreated,
      totalUpdated,
      totalUnchanged,
      totalIgnored,
      topSources,
    ] = await Promise.all([
      prisma.ingestRun.count({ where: { started_at: { gte: since } } }),
      prisma.ingestRun.count({ where: { started_at: { gte: since }, status: 'success' } }),
      prisma.ingestRun.count({ where: { started_at: { gte: since }, status: 'failed' } }),
      prisma.ingestRun.aggregate({
        where: { started_at: { gte: since } },
        _sum: { events_created: true }
      }),
      prisma.ingestRun.aggregate({
        where: { started_at: { gte: since } },
        _sum: { events_updated: true }
      }),
      prisma.ingestRun.aggregate({
        where: { started_at: { gte: since } },
        _sum: { events_unchanged: true }
      }),
      prisma.ingestRun.aggregate({
        where: { started_at: { gte: since } },
        _sum: { events_ignored: true }
      }),
      prisma.ingestRun.groupBy({
        by: ['source_id'],
        where: { started_at: { gte: since }, source_id: { not: null } },
        _count: true,
        _sum: { events_created: true },
        orderBy: { _sum: { events_created: 'desc' } },
        take: 5,
      }),
    ]);
    
    // Get source names for top sources
    const sourceIds = topSources.map(s => s.source_id).filter(Boolean) as string[];
    const sources = await prisma.source.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, name: true }
    });
    const sourceMap = new Map(sources.map(s => [s.id, s.name]));
    
    res.json({
      success: true,
      data: {
        period: '24h',
        runs: {
          total: totalRuns,
          success: successRuns,
          failed: failedRuns,
        },
        events: {
          created: totalCreated._sum.events_created || 0,
          updated: totalUpdated._sum.events_updated || 0,
          unchanged: totalUnchanged._sum.events_unchanged || 0,
          ignored: totalIgnored._sum.events_ignored || 0,
        },
        top_sources: topSources.map(s => ({
          source_id: s.source_id,
          source_name: sourceMap.get(s.source_id!) || 'Unknown',
          run_count: s._count,
          events_created: s._sum.events_created || 0,
        })),
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/ingest-runs/:id - Get single ingest run details with merge statistics
router.get('/ingest-runs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const run = await prisma.ingestRun.findUnique({
      where: { id },
      include: {
        source: {
          select: { id: true, name: true, type: true, url: true }
        }
      }
    });

    if (!run) {
      throw createError('Ingest run not found', 404, 'NOT_FOUND');
    }
    
    // Get summary of raw event items for this run
    const itemStats = await prisma.rawEventItem.groupBy({
      by: ['ingest_status'],
      where: { run_id: id },
      _count: true,
    });
    
    const itemStatusMap: Record<string, number> = {};
    for (const stat of itemStats) {
      if (stat.ingest_status) {
        itemStatusMap[stat.ingest_status] = stat._count;
      }
    }
    
    // Get items that need attention (conflicts, errors)
    const problemItems = await prisma.rawEventItem.findMany({
      where: {
        run_id: id,
        OR: [
          { ingest_status: 'ignored' },
          { ingest_status: 'conflict' },
        ]
      },
      take: 10,
      select: {
        id: true,
        fingerprint: true,
        ingest_status: true,
        ingest_result: true,
        extracted_fields: true,
      }
    });

    res.json({
      success: true,
      data: {
        ...run,
        item_stats: itemStatusMap,
        problem_items: problemItems.map(item => ({
          id: item.id,
          fingerprint: item.fingerprint,
          status: item.ingest_status,
          title: (item.extracted_fields as any)?.title || 'Unknown',
          merge_reasons: (item.ingest_result as any)?.merge_reasons || [],
        })),
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// SERVICE TOKEN GENERATION
// ============================================

import jwt from 'jsonwebtoken';

// POST /api/admin/service-token - Generate a service token for AI-Worker
router.post('/service-token', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name = 'ai-worker', scopes = ['ingest', 'crawl'], expires_in_days = 90 } = req.body;
    
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw createError('JWT_SECRET not configured', 500, 'CONFIG_ERROR');
    }
    
    // Create service token with limited scopes
    const payload = {
      sub: `service:${name}`,
      name,
      role: 'service',
      scopes,
      iat: Math.floor(Date.now() / 1000),
    };
    
    const expiresInSeconds = expires_in_days * 24 * 60 * 60;
    const token = jwt.sign(payload, secret, { expiresIn: expiresInSeconds });
    
    // Calculate expiration date
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    
    res.json({
      success: true,
      message: 'Service token generated',
      data: {
        token,
        name,
        scopes,
        expires_at: expiresAt.toISOString(),
        expires_in_days,
        usage: {
          header: 'Authorization: Bearer <token>',
          env_var: 'SERVICE_TOKEN=<token>',
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/ingest-runs/:id/items - Get raw event items for a run
router.get('/ingest-runs/:id/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { status, limit = 50, offset = 0 } = req.query;
    
    const where: any = { run_id: id };
    if (status) {
      where.ingest_status = status;
    }
    
    const [items, total] = await Promise.all([
      prisma.rawEventItem.findMany({
        where,
        take: Number(limit),
        skip: Number(offset),
        orderBy: { created_at: 'desc' },
        include: {
          canonical_event: {
            select: { id: true, title: true, status: true }
          }
        }
      }),
      prisma.rawEventItem.count({ where })
    ]);
    
    res.json({
      success: true,
      data: items,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset),
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// AI PROCESSING
// ============================================

/**
 * Helper function to determine status from AI scores
 */
function determineStatusFromAIScores(familyFitScore: number, confidence: number): string {
  // Low family fit score: not relevant for families
  if (familyFitScore < AI_THRESHOLDS.FAMILY_FIT_REJECT) {
    return 'rejected';
  }
  
  // High confidence + good family fit: auto-publish
  if (confidence >= AI_THRESHOLDS.CONFIDENCE_PUBLISH && 
      familyFitScore >= AI_THRESHOLDS.FAMILY_FIT_PUBLISH) {
    return 'published';
  }
  
  // Otherwise: manual review
  return 'pending_review';
}

// ============================================
// AI JOB STATUS TYPES & HELPERS
// ============================================

// ============================================
// VALIDATION & SUGGESTION TYPES
// ============================================

interface ValidationCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  category: 'plausibility' | 'completeness' | 'reachability';
}

interface SuggestedAction {
  id: string;
  label: string;
  description: string;
  action_type: 'crawl' | 'ai_rerun' | 'manual_edit' | 'confirm';
  field?: string;
}

interface FieldConflict {
  field: string;
  values: {
    source_type: 'feed' | 'crawl' | 'ai' | 'manual';
    source_name: string;
    value: any;
    confidence?: number;
    fetched_at: string;
  }[];
  current_winner: string;
  auto_resolved: boolean;
}

interface CrawlDiagnostics {
  http_status: number | null;
  content_type: string | null;
  load_time_ms: number | null;
  structured_data_found: string[];
  extractor_used: string | null;
  robots_blocked: boolean;
  error: string | null;
}

interface AIRunEntry {
  id: string;
  event_id: string;
  timestamp: string;
  prompt_version: string;
  model: string;
  input_hash: string;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
  processing_time_ms: number;
  result_snapshot: any;
  triggered_by: 'batch' | 'manual' | 'auto';
}

interface DuplicateCandidate {
  event_id: string;
  event_title: string;
  event_date: string | null;
  event_location: string | null;
  matching_score: number;
  confidence: string;
  resolution: string | null;
}

interface SourceMeta {
  id: string;
  source_name: string;
  source_type: string;
  source_url: string | null;
  fetched_at: string;
  field_count: number;
  fields_preview: string[];
  raw_payload?: any;
  extracted_fields?: any;
  normalized_data?: any;
  crawl_diagnostics?: CrawlDiagnostics;
}

// Compact snapshot of existing fields (known at start)
interface EventSnapshot {
  // Core fields
  title: string | null;
  description_short: string | null;
  description_long: string | null;
  start_datetime: string | null;
  end_datetime: string | null;
  is_all_day: boolean;
  // Location
  location_address: string | null;
  location_district: string | null;
  venue_name: string | null;
  city: string | null;
  postal_code: string | null;
  country_code: string | null;
  // Pricing
  price_type: string | null;
  price_min: number | null;
  price_max: number | null;
  price_details: any;
  // Age
  age_min: number | null;
  age_max: number | null;
  age_rating: string | null;
  // Details
  is_indoor: boolean;
  is_outdoor: boolean;
  booking_url: string | null;
  image_urls: any;
  availability_status: string | null;
  recurrence_rule: string | null;
  // AI
  ai_summary_short: string | null;
  // Meta
  categories: string[];
  completeness_score: number | null;
  // Provenance (new)
  field_provenance: Record<string, any>;
  field_fill_status: Record<string, any>;
}

// AI proposal after processing
interface AIProposal {
  // Classification
  categories: string[];
  age_min: number | null;
  age_max: number | null;
  age_rating: string | null;
  is_indoor: boolean;
  is_outdoor: boolean;
  ai_summary_short: string | null;
  ai_summary_highlights: string[] | null;
  ai_fit_blurb: string | null;
  // Extracted fields
  extracted_start_datetime: string | null;
  extracted_end_datetime: string | null;
  extracted_location_address: string | null;
  extracted_location_district: string | null;
  // Scores
  family_fit_score: number | null;
  relevance_score: number | null;
  quality_score: number | null;
  stressfree_score: number | null;
  // Age-Fit Buckets
  age_fit_0_2: number | null;
  age_fit_3_5: number | null;
  age_fit_6_9: number | null;
  age_fit_10_12: number | null;
  age_fit_13_15: number | null;
}

// Diff per field: what changed?
type FieldDiffType = 'unchanged' | 'added' | 'changed';

interface FieldDiffEntry {
  type: FieldDiffType;
  old_value?: any;
  new_value?: any;
}

interface FieldDiff {
  [fieldName: string]: FieldDiffEntry;
}

// Meta data per AI processing
interface AIProcessingMeta {
  model: string;
  confidence: number;
  cost_usd: number | null;
  processing_time_ms: number;
  prompt_version: string;
}

// Structured error
interface AIProcessingError {
  type: string;
  message: string;
  step: string;
  retryable: boolean;
}

// Event detail in job status
interface AIJobEventDetail {
  id: string;
  title: string;
  source_url: string | null;
  source_name: string | null;
  existing: EventSnapshot;
  proposed: AIProposal | null;
  diff: FieldDiff | null;
  meta: AIProcessingMeta | null;
  processing_status: 'waiting' | 'processing' | 'done' | 'error';
  result_status: string | null;
  missing_fields: string[];
  needs_review: boolean;
  error: AIProcessingError | null;
  // New fields for transparency
  source_type: string | null;
  crawl_url: string | null;
  has_been_crawled: boolean;
  event_sources_count: number;
  validation_checks: ValidationCheck[];
  suggested_actions: SuggestedAction[];
}

// Main status (stored in Redis)
interface AIJobStatus {
  id: string;
  status: 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  currentEventId: string | null;
  startedAt: string;
  estimatedSecondsRemaining: number | null;
  events: AIJobEventDetail[];
  summary: { published: number; pending_review: number; rejected: number; failed: number; incomplete: number; archived: number };
  total_cost_usd: number;
  last_updated_at: string;
}

// Helper: Calculate missing required fields
function calculateMissingFields(event: {
  start_datetime?: Date | null;
  end_datetime?: Date | null;
  location_address?: string | null;
  price_min?: any;
  price_max?: any;
  age_min?: number | null;
  age_max?: number | null;
  description_short?: string | null;
}): string[] {
  const missing: string[] = [];
  if (!event.start_datetime) missing.push('start_datetime');
  if (!event.location_address) missing.push('location_address');
  if (event.price_min === null && event.price_max === null) missing.push('price');
  if (event.age_min === null && event.age_max === null) missing.push('age_range');
  if (!event.description_short) missing.push('description_short');
  return missing;
}

// Helper: Calculate diff between existing and proposed values
function calculateFieldDiff(
  existing: EventSnapshot,
  proposed: AIProposal,
  appliedFields: Record<string, any>
): FieldDiff {
  const diff: FieldDiff = {};
  
  // Helper to add diff entry
  const addDiff = (field: string, oldVal: any, newVal: any) => {
    if (newVal === undefined || newVal === null) {
      diff[field] = { type: 'unchanged', old_value: oldVal };
    } else if (oldVal === null || oldVal === undefined || (Array.isArray(oldVal) && oldVal.length === 0)) {
      diff[field] = { type: 'added', new_value: newVal };
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diff[field] = { type: 'changed', old_value: oldVal, new_value: newVal };
    } else {
      diff[field] = { type: 'unchanged', old_value: oldVal };
    }
  };
  
  // Compare classification fields
  addDiff('categories', existing.categories, proposed.categories);
  addDiff('age_min', existing.age_min, proposed.age_min);
  addDiff('age_max', existing.age_max, proposed.age_max);
  addDiff('age_rating', null, proposed.age_rating);
  addDiff('is_indoor', existing.is_indoor, proposed.is_indoor);
  addDiff('is_outdoor', existing.is_outdoor, proposed.is_outdoor);
  
  // AI-generated fields (always 'added' since they don't exist before)
  if (proposed.ai_summary_short) addDiff('ai_summary_short', null, proposed.ai_summary_short);
  if (proposed.ai_fit_blurb) addDiff('ai_fit_blurb', null, proposed.ai_fit_blurb);
  if (proposed.ai_summary_highlights) addDiff('ai_summary_highlights', null, proposed.ai_summary_highlights);
  
  // Extracted fields
  if (proposed.extracted_start_datetime && !existing.start_datetime) {
    addDiff('start_datetime', existing.start_datetime, proposed.extracted_start_datetime);
  }
  if (proposed.extracted_end_datetime && !existing.end_datetime) {
    addDiff('end_datetime', existing.end_datetime, proposed.extracted_end_datetime);
  }
  if (proposed.extracted_location_address && !existing.location_address) {
    addDiff('location_address', existing.location_address, proposed.extracted_location_address);
  }
  if (proposed.extracted_location_district && !existing.location_district) {
    addDiff('location_district', existing.location_district, proposed.extracted_location_district);
  }
  
  // Scores (always added)
  if (proposed.family_fit_score !== null) addDiff('family_fit_score', null, proposed.family_fit_score);
  if (proposed.relevance_score !== null) addDiff('relevance_score', null, proposed.relevance_score);
  if (proposed.quality_score !== null) addDiff('quality_score', null, proposed.quality_score);
  if (proposed.stressfree_score !== null) addDiff('stressfree_score', null, proposed.stressfree_score);
  
  return diff;
}

// Helper: Calculate validation checks for an event
function calculateValidationChecks(event: {
  title?: string | null;
  start_datetime?: Date | null;
  end_datetime?: Date | null;
  location_address?: string | null;
  location_lat?: any;
  location_lng?: any;
  price_min?: any;
  price_max?: any;
  age_min?: number | null;
  age_max?: number | null;
  description_short?: string | null;
  booking_url?: string | null;
  image_urls?: any;
}): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  // Completeness checks
  if (!event.title) {
    checks.push({ id: 'title_missing', label: 'Titel fehlt', status: 'fail', message: 'Event hat keinen Titel', category: 'completeness' });
  }
  if (!event.start_datetime) {
    checks.push({ id: 'date_missing', label: 'Datum fehlt', status: 'fail', message: 'Kein Startdatum vorhanden', category: 'completeness' });
  }
  if (!event.location_address) {
    checks.push({ id: 'address_missing', label: 'Adresse fehlt', status: 'warn', message: 'Keine Adresse vorhanden', category: 'completeness' });
  }
  if (!event.description_short || event.description_short.length < 30) {
    checks.push({ id: 'desc_short', label: 'Beschreibung zu kurz', status: 'warn', message: event.description_short ? `Nur ${event.description_short.length} Zeichen` : 'Keine Beschreibung', category: 'completeness' });
  }
  if (event.price_min === null && event.price_max === null) {
    checks.push({ id: 'price_missing', label: 'Preis fehlt', status: 'warn', message: 'Keine Preisinformation', category: 'completeness' });
  }
  const imgUrls = Array.isArray(event.image_urls) ? event.image_urls : [];
  if (imgUrls.length === 0) {
    checks.push({ id: 'image_missing', label: 'Bild fehlt', status: 'warn', message: 'Kein Bild vorhanden', category: 'completeness' });
  }

  // Plausibility checks
  if (event.start_datetime && new Date(event.start_datetime) < new Date()) {
    checks.push({ id: 'date_past', label: 'Datum in Vergangenheit', status: 'fail', message: 'Startdatum liegt in der Vergangenheit', category: 'plausibility' });
  }
  if (event.age_min != null && event.age_max != null && event.age_min > event.age_max) {
    checks.push({ id: 'age_invalid', label: 'Alter ungueltig', status: 'fail', message: `age_min (${event.age_min}) > age_max (${event.age_max})`, category: 'plausibility' });
  }
  const priceMin = event.price_min !== null && event.price_min !== undefined ? Number(event.price_min) : null;
  const priceMax = event.price_max !== null && event.price_max !== undefined ? Number(event.price_max) : null;
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    checks.push({ id: 'price_invalid', label: 'Preis ungueltig', status: 'fail', message: `price_min (${priceMin}) > price_max (${priceMax})`, category: 'plausibility' });
  }

  // Reachability checks
  if (event.location_address && (!event.location_lat || !event.location_lng)) {
    checks.push({ id: 'geocode_missing', label: 'Geocode fehlt', status: 'warn', message: 'Adresse vorhanden aber kein Geocode', category: 'reachability' });
  }

  // If no issues found, add a pass
  if (checks.length === 0) {
    checks.push({ id: 'all_ok', label: 'Alle Checks bestanden', status: 'pass', message: 'Keine Probleme gefunden', category: 'completeness' });
  }

  return checks;
}

// Helper: Calculate suggested next actions for an event
function calculateSuggestedActions(event: {
  location_address?: string | null;
  start_datetime?: Date | null;
  description_short?: string | null;
  image_urls?: any;
  location_lat?: any;
  ai_summary_short?: string | null;
}, crawlUrl: string | null, hasCrawled: boolean): SuggestedAction[] {
  const actions: SuggestedAction[] = [];

  if (!event.location_address && crawlUrl && !hasCrawled) {
    actions.push({ id: 'crawl_address', label: 'Website crawlen fuer Adresse', description: 'Adresse fehlt - Website koennte sie enthalten', action_type: 'crawl', field: 'location_address' });
  }
  if (!event.start_datetime) {
    actions.push({ id: 'ai_datetime', label: 'AI Extraktion fuer Datum', description: 'Startzeit fehlt - AI kann sie aus dem Text extrahieren', action_type: 'ai_rerun', field: 'start_datetime' });
  }
  if (!event.description_short || event.description_short.length < 50) {
    actions.push({ id: 'ai_summary', label: 'AI Summary generieren', description: 'Beschreibung sehr kurz - AI kann eine Zusammenfassung erstellen', action_type: 'ai_rerun', field: 'ai_summary_short' });
  }
  const imgUrls = Array.isArray(event.image_urls) ? event.image_urls : [];
  if (imgUrls.length === 0 && crawlUrl && !hasCrawled) {
    actions.push({ id: 'crawl_images', label: 'Website crawlen fuer Bilder', description: 'Kein Bild vorhanden - Website koennte Bilder enthalten', action_type: 'crawl', field: 'image_urls' });
  }
  if (event.location_address && !event.location_lat) {
    actions.push({ id: 'confirm_geocode', label: 'Adresse manuell bestaetigen', description: 'Geocode fehlt oder low confidence', action_type: 'confirm', field: 'location_address' });
  }
  if (!event.ai_summary_short) {
    actions.push({ id: 'generate_summary', label: 'AI Zusammenfassung erstellen', description: 'Keine AI-Zusammenfassung vorhanden', action_type: 'ai_rerun', field: 'ai_summary_short' });
  }

  return actions;
}

const AI_JOB_PREFIX = 'ai-job:';
const AI_JOB_TTL = 86400; // 24 hours (for job history)

async function updateAIJobStatus(jobId: string, update: Partial<AIJobStatus>): Promise<void> {
  if (!redis || !isRedisAvailable()) return;
  
  const key = `${AI_JOB_PREFIX}${jobId}`;
  const existing = await redis.get(key);
  const current: AIJobStatus = existing ? JSON.parse(existing) : {};
  const updated = { ...current, ...update, last_updated_at: new Date().toISOString() };
  
  await redis.setex(key, AI_JOB_TTL, JSON.stringify(updated));
}

// Update single event in job status
async function updateAIJobEventStatus(
  jobId: string, 
  eventId: string, 
  eventUpdate: Partial<AIJobEventDetail>
): Promise<void> {
  if (!redis || !isRedisAvailable()) return;
  
  const key = `${AI_JOB_PREFIX}${jobId}`;
  const existing = await redis.get(key);
  if (!existing) return;
  
  const current: AIJobStatus = JSON.parse(existing);
  const eventIndex = current.events.findIndex(e => e.id === eventId);
  if (eventIndex === -1) return;
  
  current.events[eventIndex] = { ...current.events[eventIndex], ...eventUpdate };
  current.last_updated_at = new Date().toISOString();
  
  await redis.setex(key, AI_JOB_TTL, JSON.stringify(current));
}

async function getAIJobStatus(jobId: string): Promise<AIJobStatus | null> {
  if (!redis || !isRedisAvailable()) return null;
  
  const key = `${AI_JOB_PREFIX}${jobId}`;
  const data = await redis.get(key);
  
  return data ? JSON.parse(data) : null;
}

// POST /api/admin/process-pending-ai - Process events with pending_ai status through AI Worker
router.post('/process-pending-ai', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const sourceId = typeof req.query.source_id === 'string' ? req.query.source_id : undefined;
    const forceCrawlFirst = req.query.force_crawl_first === 'true';
    const userId = req.user?.sub;

    // Stale-Jobs aufräumen: ältesten "running" Job prüfen und ggf. als stale markieren
    const anyRunning = await prisma.aiJob.findFirst({
      where: { status: 'running' },
      orderBy: { started_at: 'desc' },
    });
    if (anyRunning) {
      await checkAndMarkStale(anyRunning);
    }

    // Check if there's already a running job (not stale)
    const existingJob = await prisma.aiJob.findFirst({
      where: {
        status: 'running',
        last_heartbeat: { gte: new Date(Date.now() - STALE_THRESHOLD_MS) }
      }
    });

    if (existingJob) {
      logger.info(`process-pending-ai: blockiert durch laufenden Job ${existingJob.id}`);
      return res.status(409).json({
        success: false,
        error: 'Ein AI-Batch läuft bereits',
        activeJobId: existingJob.id,
        message: `Job ${existingJob.id} ist aktiv (${existingJob.processed}/${existingJob.total} verarbeitet)`
      });
    }

    // #region agent log
    _debugLog({ location: 'admin.ts:process-pending-ai:before-find', message: 'before findMany pending_ai', hypothesisId: 'H4', data: { limit: Number(req.query.limit || 50) } });
    // #endregion
    // Get events with pending_ai status - optionally filter by source_id
    let pendingEvents = await prisma.canonicalEvent.findMany({
      where: {
        status: 'pending_ai',
        ...(sourceId ? { event_sources: { some: { source_id: sourceId } } } : {}),
      },
      take: limit,
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        title: true,
        description_short: true,
        description_long: true,
        location_address: true,
        location_district: true,
        start_datetime: true,
        end_datetime: true,
        price_min: true,
        price_max: true,
        price_type: true,
        age_min: true,
        age_max: true,
        is_indoor: true,
        is_outdoor: true,
        completeness_score: true,
        field_provenance: true,
        field_fill_status: true,
        venue_name: true,
        city: true,
        postal_code: true,
        country_code: true,
        price_details: true,
        booking_url: true,
        image_urls: true,
        availability_status: true,
        recurrence_rule: true,
        age_rating: true,
        is_all_day: true,
        ai_summary_short: true,
        location_lat: true,
        location_lng: true,
        categories: {
          select: {
            category: {
              select: { slug: true }
            }
          }
        },
        event_sources: {
          orderBy: { updated_at: 'desc' as const },
          select: {
            id: true,
            source_url: true,
            fetched_at: true,
            source: {
              select: { id: true, name: true, type: true, url: true, detail_page_config: true }
            }
          }
        },
        provider: {
          select: { name: true }
        }
      }
    });
    // #region agent log
    _debugLog({ location: 'admin.ts:process-pending-ai:after-find', message: 'after findMany pending_ai', hypothesisId: 'H4', data: { pendingCount: pendingEvents.length, aiWorkerUrlSet: !!process.env.AI_WORKER_URL } });
    // #endregion
    if (pendingEvents.length === 0) {
      const pendingAiCount = await prisma.canonicalEvent.count({ where: { status: 'pending_ai' } });
      logger.info(`process-pending-ai: keine Events (pending_ai count=${pendingAiCount})`);
      return res.json({
        success: true,
        message: 'No pending events to process',
        processed: 0,
        jobId: null,
        events: [],
        pending_ai_count: pendingAiCount,
        hint: 'Events mit Status "pending_ai" entstehen durch Crawl/Ingest (Quellen crawlen).',
        summary: { published: 0, pending_review: 0, rejected: 0, failed: 0, incomplete: 0, archived: 0 }
      });
    }

    // Optional: crawl + merge for each event before AI (so classify/score get fresh data)
    if (forceCrawlFirst) {
      const nowIso = new Date().toISOString();
      for (const event of pendingEvents) {
        const crawlUrl = event.booking_url || event.event_sources?.[0]?.source_url || null;
        if (!crawlUrl) continue;

        // Find source matching crawl URL domain
        let matchedSource: { id: string; detail_page_config: unknown; url: string | null } | null = null;
        try {
          const crawlDomain = new URL(crawlUrl).hostname;
          matchedSource = event.event_sources
            .map((es: any) => es.source)
            .find((s: any) => s?.url && new URL(s.url).hostname === crawlDomain) || null;
        } catch { /* skip */ }
        if (!matchedSource) matchedSource = (event.event_sources[0] as any)?.source || null;

        const fieldsNeeded: string[] = [];
        if (!event.location_address || (typeof event.location_address === 'string' && !event.location_address.trim())) fieldsNeeded.push('location_address');
        if (!event.start_datetime) fieldsNeeded.push('start_datetime');
        if (!event.end_datetime) fieldsNeeded.push('end_datetime');
        if (!Array.isArray(event.image_urls) || event.image_urls.length === 0) fieldsNeeded.push('image_url');
        if (fieldsNeeded.length === 0) continue;
        try {
          const crawlRes = await fetch(`${AI_WORKER_URL}/crawl/single-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: crawlUrl,
              fields_needed: fieldsNeeded,
              detail_page_config: matchedSource?.detail_page_config || null,
              source_id: matchedSource?.id || null,
            }),
            signal: AbortSignal.timeout(20000),
          });
          const crawlResult = await crawlRes.json() as { success: boolean; fields_found?: Record<string, unknown>; error?: string };
          if (!crawlRes.ok || !crawlResult.success) continue;
          const existingFieldFillStatus = (event.field_fill_status as Record<string, FieldFillStatusValue>) || {};
          const eventUpdate: Record<string, unknown> = {};
          if (crawlResult.fields_found?.location_address) {
            eventUpdate.location_address = crawlResult.fields_found.location_address;
            existingFieldFillStatus['location_address'] = { status: 'filled', source: 'crawl', last_attempt: nowIso };
          }
          if (crawlResult.fields_found?.start_datetime) {
            try {
              eventUpdate.start_datetime = new Date(crawlResult.fields_found.start_datetime as string);
              existingFieldFillStatus['start_datetime'] = { status: 'filled', source: 'crawl', last_attempt: nowIso };
            } catch { /* ignore */ }
          }
          if (crawlResult.fields_found?.end_datetime) {
            try {
              eventUpdate.end_datetime = new Date(crawlResult.fields_found.end_datetime as string);
              existingFieldFillStatus['end_datetime'] = { status: 'filled', source: 'crawl', last_attempt: nowIso };
            } catch { /* ignore */ }
          }
          if (Object.keys(eventUpdate).length > 0) {
            await prisma.canonicalEvent.update({
              where: { id: event.id },
              data: { ...eventUpdate, field_fill_status: existingFieldFillStatus },
            });
          }
        } catch {
          // Skip failed crawl and continue with next event
        }
      }
      // Re-fetch events so background job uses updated data
      pendingEvents = await prisma.canonicalEvent.findMany({
        where: { id: { in: pendingEvents.map(e => e.id) } },
        orderBy: { created_at: 'asc' },
        select: {
          id: true,
          title: true,
          description_short: true,
          description_long: true,
          location_address: true,
          location_district: true,
          start_datetime: true,
          end_datetime: true,
          price_min: true,
          price_max: true,
          price_type: true,
          age_min: true,
          age_max: true,
          is_indoor: true,
          is_outdoor: true,
          completeness_score: true,
          field_provenance: true,
          field_fill_status: true,
          venue_name: true,
          city: true,
          postal_code: true,
          country_code: true,
          price_details: true,
          booking_url: true,
          image_urls: true,
          availability_status: true,
          recurrence_rule: true,
          age_rating: true,
          is_all_day: true,
          ai_summary_short: true,
          location_lat: true,
          location_lng: true,
          categories: {
            select: {
              category: {
                select: { slug: true }
              }
            }
          },
          event_sources: {
            orderBy: { updated_at: 'desc' as const },
            select: {
              id: true,
              source_url: true,
              fetched_at: true,
              source: {
                select: { id: true, name: true, type: true, url: true }
              }
            }
          },
          provider: {
            select: { name: true }
          }
        }
      });
    }

    // Create job in database for persistent tracking
    const dbJob = await prisma.aiJob.create({
      data: {
        total: pendingEvents.length,
        processed: 0,
        status: 'running',
        created_by: userId,
        summary: { published: 0, pending_review: 0, rejected: 0, failed: 0, incomplete: 0, archived: 0 },
      }
    });
    
    const jobId = dbJob.id;
    const startedAt = dbJob.started_at.toISOString();
    // #region agent log
    _debugLog({ location: 'admin.ts:process-pending-ai:job-created', message: 'AiJob created', hypothesisId: 'H2', data: { jobId, total: pendingEvents.length } });
    // #endregion
    // Build event details with existing snapshot
    const eventDetails: AIJobEventDetail[] = pendingEvents.map(event => {
      const existingCategories = event.categories.map(c => c.category.slug);
      
      const existing: EventSnapshot = {
        title: event.title,
        description_short: event.description_short,
        description_long: event.description_long,
        start_datetime: event.start_datetime?.toISOString() || null,
        end_datetime: event.end_datetime?.toISOString() || null,
        is_all_day: event.is_all_day,
        location_address: event.location_address,
        location_district: event.location_district,
        venue_name: event.venue_name,
        city: event.city,
        postal_code: event.postal_code,
        country_code: event.country_code,
        price_type: event.price_type,
        price_min: event.price_min ? Number(event.price_min) : null,
        price_max: event.price_max ? Number(event.price_max) : null,
        price_details: event.price_details,
        age_min: event.age_min,
        age_max: event.age_max,
        age_rating: event.age_rating,
        is_indoor: event.is_indoor,
        is_outdoor: event.is_outdoor,
        booking_url: event.booking_url,
        image_urls: event.image_urls,
        availability_status: event.availability_status,
        recurrence_rule: event.recurrence_rule,
        ai_summary_short: event.ai_summary_short,
        categories: existingCategories,
        completeness_score: event.completeness_score,
        field_provenance: (event.field_provenance as Record<string, any>) || {},
        field_fill_status: (event.field_fill_status as Record<string, any>) || {},
      };
      
      // Determine crawl URL and status
      const allSources = event.event_sources;
      const sourceInfo = allSources[0];
      const crawlUrl = event.booking_url || sourceInfo?.source_url || null;
      const hasCrawled = allSources.length > 1 || ((event.field_fill_status as any)?.location_address?.source === 'crawl');
      
      return {
        id: event.id,
        title: event.title || 'Unbekannt',
        source_url: sourceInfo?.source_url || null,
        source_name: sourceInfo?.source?.name || event.provider?.name || null,
        existing,
        proposed: null,
        diff: null,
        meta: null,
        processing_status: 'waiting' as const,
        result_status: null,
        missing_fields: calculateMissingFields(event),
        needs_review: false,
        error: null,
        // New transparency fields
        source_type: sourceInfo?.source?.type || null,
        crawl_url: crawlUrl,
        has_been_crawled: hasCrawled,
        event_sources_count: allSources.length,
        validation_checks: calculateValidationChecks(event),
        suggested_actions: calculateSuggestedActions(event, crawlUrl, hasCrawled),
      };
    });
    
    const initialStatus: AIJobStatus = {
      id: jobId,
      status: 'running',
      total: pendingEvents.length,
      processed: 0,
      currentEventId: null,
      startedAt,
      estimatedSecondsRemaining: pendingEvents.length * 3,
      events: eventDetails,
      summary: { published: 0, pending_review: 0, rejected: 0, failed: 0, incomplete: 0, archived: 0 },
      total_cost_usd: 0,
      last_updated_at: startedAt,
    };
    
    // Store initial status in Redis (if available)
    if (redis && isRedisAvailable()) {
      await redis.setex(`${AI_JOB_PREFIX}${jobId}`, AI_JOB_TTL, JSON.stringify(initialStatus));
    }
    
    logger.info(`process-pending-ai: Batch gestartet jobId=${jobId} count=${pendingEvents.length}`);
    
    // Return immediately with job ID and event snapshots
    res.json({
      success: true,
      jobId,
      total: pendingEvents.length,
      events: eventDetails,
      message: 'Processing started',
    });
    
    // Process events in the background
    setImmediate(async () => {
      // #region agent log
      _debugLog({ location: 'admin.ts:setImmediate:entry', message: 'background loop started', hypothesisId: 'H2', data: { jobId, total: pendingEvents.length } });
      // #endregion
      try {
      const summary = { published: 0, pending_review: 0, rejected: 0, failed: 0, incomplete: 0, archived: 0 };
      const startTime = Date.now();
      let totalCostUsd = 0;
      
      for (let i = 0; i < pendingEvents.length; i++) {
        const event = pendingEvents[i];
        const eventDetail = eventDetails[i];
        const eventStartTime = Date.now();
        
        // Mark event as processing - update both DB (heartbeat) and Redis (details)
        await prisma.aiJob.update({
          where: { id: jobId },
          data: {
            current_event_id: event.id,
            processed: i,
            last_heartbeat: new Date(),
          }
        });
        
        await updateAIJobEventStatus(jobId, event.id, { processing_status: 'processing' });
        await updateAIJobStatus(jobId, {
          processed: i,
          currentEventId: event.id,
          estimatedSecondsRemaining: i > 0 
            ? Math.round(((Date.now() - startTime) / i) * (pendingEvents.length - i) / 1000)
            : (pendingEvents.length - i) * 3,
        });
        // #region agent log
        if (i === 0) _debugLog({ location: 'admin.ts:before-classify', message: 'before first classify fetch', hypothesisId: 'H1,H3', data: { jobId, eventIndex: i, eventId: event.id } });
        // #endregion
        const AI_REQUEST_TIMEOUT_MS = 90_000; // 90s per request so batch does not hang
        try {
          // Step 1: Classification (with timeout so stuck AI Worker does not block forever)
          const classifyRes = await fetch(`${AI_WORKER_URL}/classify/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: event.title,
              description: (event.description_long || event.description_short || ''),
              location_address: event.location_address || '',
              price_min: event.price_min ? Number(event.price_min) : null,
              price_max: event.price_max ? Number(event.price_max) : null,
              is_indoor: event.is_indoor,
              is_outdoor: event.is_outdoor,
            }),
            signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
          });
          // #region agent log
          if (i === 0) _debugLog({ location: 'admin.ts:after-classify', message: 'after classify fetch', hypothesisId: 'H1,H5', data: { jobId, eventIndex: i, status: classifyRes.status, ok: classifyRes.ok } });
          // #endregion
          if (!classifyRes.ok) {
            const errorText = await classifyRes.text();
            throw { step: 'classification', message: `Classification failed: ${classifyRes.status} - ${errorText}` };
          }
          const classification = await classifyRes.json() as any;
          
          // Step 2: Scoring (with timeout)
          const scoreRes = await fetch(`${AI_WORKER_URL}/classify/score`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: event.title,
              description: (event.description_long || event.description_short || ''),
              location_address: event.location_address || '',
            }),
            signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
          });
          
          if (!scoreRes.ok) {
            const errorText = await scoreRes.text();
            throw { step: 'scoring', message: `Scoring failed: ${scoreRes.status} - ${errorText}` };
          }
          const scores = await scoreRes.json() as any;
          
          // Step 3: Determine new status based on AI scores
          let newStatus = determineStatusFromAIScores(
            scores.family_fit_score,
            classification.confidence
          );
          
          // Handle extracted datetime/location from AI
          const extractedStartDatetime = classification.extracted_start_datetime;
          const extractedEndDatetime = classification.extracted_end_datetime;
          const extractedLocationAddress = classification.extracted_location_address;
          const extractedLocationDistrict = classification.extracted_location_district;
          const datetimeConfidence = classification.datetime_confidence || 0;
          const locationConfidence = classification.location_confidence || 0;
          
          let effectiveStartDatetime = event.start_datetime;
          if (!effectiveStartDatetime && extractedStartDatetime && datetimeConfidence >= 0.7) {
            try {
              effectiveStartDatetime = new Date(extractedStartDatetime);
              logger.info(`Event ${event.id}: AI extracted start_datetime with confidence ${datetimeConfidence}`);
            } catch {
              logger.warn(`Event ${event.id}: Failed to parse extracted datetime: ${extractedStartDatetime}`);
            }
          }
          
          // Validate start_datetime before publishing
          if (newStatus === 'published') {
            if (!effectiveStartDatetime) {
              newStatus = 'incomplete';
              logger.warn(`Event ${event.id} has no start_datetime, setting to incomplete instead of published`);
            } else if (new Date(effectiveStartDatetime) < new Date()) {
              newStatus = 'archived';
              logger.warn(`Event ${event.id} start_datetime is in the past, setting to archived instead of published`);
            }
          }
          
          // Build AI proposal
          const proposed: AIProposal = {
            categories: classification.categories || [],
            age_min: classification.age_min ?? null,
            age_max: classification.age_max ?? null,
            age_rating: classification.age_rating ?? null,
            is_indoor: classification.is_indoor ?? event.is_indoor,
            is_outdoor: classification.is_outdoor ?? event.is_outdoor,
            ai_summary_short: classification.ai_summary_short ?? null,
            ai_summary_highlights: classification.ai_summary_highlights ?? null,
            ai_fit_blurb: classification.ai_fit_blurb ?? null,
            extracted_start_datetime: extractedStartDatetime || null,
            extracted_end_datetime: extractedEndDatetime || null,
            extracted_location_address: extractedLocationAddress || null,
            extracted_location_district: extractedLocationDistrict || null,
            family_fit_score: scores.family_fit_score ?? null,
            relevance_score: scores.relevance_score ?? null,
            quality_score: scores.quality_score ?? null,
            stressfree_score: scores.stressfree_score ?? null,
            age_fit_0_2: classification.age_fit_buckets?.["0_2"] ?? null,
            age_fit_3_5: classification.age_fit_buckets?.["3_5"] ?? null,
            age_fit_6_9: classification.age_fit_buckets?.["6_9"] ?? null,
            age_fit_10_12: classification.age_fit_buckets?.["10_12"] ?? null,
            age_fit_13_15: classification.age_fit_buckets?.["13_15"] ?? null,
          };
          
          // Calculate diff
          const diff = calculateFieldDiff(eventDetail.existing, proposed, {});
          
          // Build update data
          const updateData: Record<string, any> = {
            status: newStatus,
            age_min: classification.age_min ?? undefined,
            age_max: classification.age_max ?? undefined,
            age_rating: classification.age_rating ?? undefined,
            is_indoor: classification.is_indoor,
            is_outdoor: classification.is_outdoor,
            ai_summary_short: classification.ai_summary_short ?? undefined,
            ai_fit_blurb: classification.ai_fit_blurb ?? undefined,
            ai_summary_highlights: classification.ai_summary_highlights ?? undefined,
            ai_summary_confidence: classification.summary_confidence ?? undefined,
            age_fit_0_2: classification.age_fit_buckets?.["0_2"] ?? undefined,
            age_fit_3_5: classification.age_fit_buckets?.["3_5"] ?? undefined,
            age_fit_6_9: classification.age_fit_buckets?.["6_9"] ?? undefined,
            age_fit_10_12: classification.age_fit_buckets?.["10_12"] ?? undefined,
            age_fit_13_15: classification.age_fit_buckets?.["13_15"] ?? undefined,
            ai_flags: classification.flags ?? undefined,
          };
          
          // Add extracted datetime if not already present and confidence >= 0.7
          if (!event.start_datetime && extractedStartDatetime && datetimeConfidence >= 0.7) {
            try {
              updateData.start_datetime = new Date(extractedStartDatetime);
            } catch { /* ignore parse errors */ }
          }
          if (!event.end_datetime && extractedEndDatetime && datetimeConfidence >= 0.7) {
            try {
              updateData.end_datetime = new Date(extractedEndDatetime);
            } catch { /* ignore parse errors */ }
          }
          
          // Add extracted location if not already present and confidence >= 0.7
          if (!event.location_address && extractedLocationAddress && locationConfidence >= 0.7) {
            updateData.location_address = extractedLocationAddress;
          }
          if (!event.location_district && extractedLocationDistrict && locationConfidence >= 0.7) {
            updateData.location_district = extractedLocationDistrict;
          }
          
          // Update field_provenance for AI-set fields
          const existingProvenance = (event.field_provenance as Record<string, string>) || {};
          const newProvenance = { ...existingProvenance };
          for (const [field, d] of Object.entries(diff)) {
            if (d.type === 'added' || d.type === 'changed') {
              newProvenance[field] = 'ai_classify';
            }
          }
          updateData.field_provenance = newProvenance;
          
          // Update the event
          await prisma.canonicalEvent.update({
            where: { id: event.id },
            data: updateData
          });
          
          // Create EventRevision for audit trail
          const changedFields = Object.entries(diff)
            .filter(([_, d]) => d.type !== 'unchanged')
            .map(([field, d]) => ({ field, type: d.type, old_value: d.old_value, new_value: d.new_value }));
          
          if (changedFields.length > 0) {
            await prisma.eventRevision.create({
              data: {
                event_id: event.id,
                changeset: {
                  source: 'ai_batch',
                  job_id: jobId,
                  model: classification.model || 'gpt-4o-mini',
                  confidence: classification.confidence,
                  changes: changedFields,
                },
                status: 'approved',
              }
            });
          }
          
          // Create/update EventScore
          await prisma.eventScore.upsert({
            where: { event_id: event.id },
            create: {
              event_id: event.id,
              relevance_score: scores.relevance_score,
              quality_score: scores.quality_score,
              family_fit_score: scores.family_fit_score,
              stressfree_score: scores.stressfree_score,
              confidence: classification.confidence,
              ai_model_version: 'classify-v1',
            },
            update: {
              relevance_score: scores.relevance_score,
              quality_score: scores.quality_score,
              family_fit_score: scores.family_fit_score,
              stressfree_score: scores.stressfree_score,
              confidence: classification.confidence,
              scored_at: new Date(),
            }
          });
          
          // Add categories if provided
          if (classification.categories && classification.categories.length > 0) {
            const categories = await prisma.category.findMany({
              where: { slug: { in: classification.categories } }
            });
            for (const cat of categories) {
              await prisma.eventCategory.upsert({
                where: { 
                  event_id_category_id: { 
                    event_id: event.id, 
                    category_id: cat.id 
                  } 
                },
                create: { event_id: event.id, category_id: cat.id },
                update: {},
              });
            }
          }
          
          // Calculate processing time and estimate cost
          const processingTimeMs = Date.now() - eventStartTime;
          const estimatedCostUsd = 0.003; // Rough estimate for gpt-4o-mini
          totalCostUsd += estimatedCostUsd;
          
          // Build meta
          const meta: AIProcessingMeta = {
            model: classification.model || 'gpt-4o-mini',
            confidence: classification.confidence || 0,
            cost_usd: estimatedCostUsd,
            processing_time_ms: processingTimeMs,
            prompt_version: 'v1',
          };
          
          // Update summary
          if (newStatus === 'published') summary.published++;
          else if (newStatus === 'pending_review') summary.pending_review++;
          else if (newStatus === 'rejected') summary.rejected++;
          else if (newStatus === 'incomplete') summary.incomplete++;
          else if (newStatus === 'archived') summary.archived++;
          
          // Determine if needs review
          const needsReview = newStatus === 'pending_review' || 
            (classification.confidence < 0.7) ||
            (scores.family_fit_score >= 40 && scores.family_fit_score < 60);
          
          // Update event status in Redis
          await updateAIJobEventStatus(jobId, event.id, {
            proposed,
            diff,
            meta,
            processing_status: 'done',
            result_status: newStatus,
            needs_review: needsReview,
          });
          
          logger.info(`Processed event ${event.id}: ${newStatus} (family_fit: ${scores.family_fit_score}, confidence: ${classification.confidence})`);
          
        } catch (err: any) {
          // #region agent log
          _debugLog({ location: 'admin.ts:catch', message: 'event processing error', hypothesisId: 'H1,H3,H5', data: { jobId, eventIndex: i, eventId: event.id, errName: err?.name, errCode: err?.code, errStep: err?.step, errMessage: (err?.message || '').slice(0, 200) } });
          // #endregion
          const isAbort = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
          let errorMessage = isAbort
            ? 'AI Worker Timeout (90s) – Worker nicht erreichbar oder zu langsam'
            : normalizeAIWorker404Message(err?.message || (err instanceof Error ? err.message : 'Unknown error'));
          const errorStep = err?.step || (isAbort ? 'timeout' : 'unknown');
          summary.failed++;
          
          await updateAIJobEventStatus(jobId, event.id, {
            processing_status: 'error',
            error: {
              type: 'processing_error',
              message: errorMessage,
              step: errorStep,
              retryable: true,
            },
          });
          
          logger.error(`Failed to process event ${event.id}: ${errorMessage}`);
        }
        
        // Update global progress after each event (both DB and Redis)
        await prisma.aiJob.update({
          where: { id: jobId },
          data: {
            processed: i + 1,
            last_heartbeat: new Date(),
            summary: { ...summary },
            total_cost_usd: totalCostUsd,
          }
        });
        // #region agent log
        _debugLog({ location: 'admin.ts:after-event-update', message: 'processed count updated', hypothesisId: 'H2', data: { jobId, processed: i + 1, total: pendingEvents.length, failed: summary.failed } });
        // #endregion
        await updateAIJobStatus(jobId, {
          processed: i + 1,
          summary: { ...summary },
          total_cost_usd: totalCostUsd,
        });
      }
      
      // Mark job as completed in both DB and Redis
      await prisma.aiJob.update({
        where: { id: jobId },
        data: {
          status: 'completed',
          processed: pendingEvents.length,
          current_event_id: null,
          completed_at: new Date(),
          summary,
          total_cost_usd: totalCostUsd,
        }
      });
      
      await updateAIJobStatus(jobId, {
        status: 'completed',
        processed: pendingEvents.length,
        currentEventId: null,
        estimatedSecondsRemaining: 0,
        summary,
        total_cost_usd: totalCostUsd,
      });
      
      logger.info(`AI job ${jobId} completed: ${JSON.stringify(summary)}`);
      } catch (loopErr: any) {
        // #region agent log
        _debugLog({ location: 'admin.ts:setImmediate:catch', message: 'background loop threw', hypothesisId: 'H2,H3', data: { jobId, errName: loopErr?.name, errMessage: (loopErr?.message || '').slice(0, 300) } });
        // #endregion
        try {
          await prisma.aiJob.update({ where: { id: jobId }, data: { status: 'failed', completed_at: new Date() } });
        } catch (_) { /* ignore */ }
      }
    });
    
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/ai-job-status/:jobId - Get status of an AI processing job (HYBRID: DB + Redis)
// Supports ?changed_since=<ISO-timestamp> for efficient polling (only returns changed events)
router.get('/ai-job-status/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { jobId } = req.params;
    const { changed_since } = req.query;
    
    // 1. First check the database (always available, source of truth for job status)
    let dbJob = await prisma.aiJob.findUnique({ where: { id: jobId } });
    
    if (!dbJob) {
      // Fallback: Try Redis if DB doesn't have it (for backwards compatibility)
      if (redis && isRedisAvailable()) {
        const redisStatus = await getAIJobStatus(jobId);
        if (redisStatus) {
          return res.json({
            success: true,
            data: { ...redisStatus, has_changes: true, source: 'redis_only' },
          });
        }
      }
      return res.status(404).json({
        success: false,
        error: 'Job not found',
      });
    }
    
    // 2. Check for stale job
    dbJob = await checkAndMarkStale(dbJob);
    if (!dbJob) {
      return res.status(500).json({ success: false, error: 'Job state invalid' });
    }

    // 3. Get event details from Redis (optional, graceful degradation)
    let events: AIJobEventDetail[] = [];
    let redisAvailable = false;
    
    if (redis && isRedisAvailable()) {
      redisAvailable = true;
      const redisData = await redis.get(`${AI_JOB_PREFIX}${jobId}`);
      if (redisData) {
        const parsed = JSON.parse(redisData);
        events = parsed.events || [];
      }
    }
    
    // 4. Calculate heartbeat info
    const heartbeatAgeMs = Date.now() - new Date(dbJob.last_heartbeat).getTime();
    const heartbeatAgeSeconds = Math.floor(heartbeatAgeMs / 1000);
    const heartbeatStatus = dbJob.status === 'running'
      ? (heartbeatAgeSeconds < 120 ? 'healthy' : heartbeatAgeSeconds < 300 ? 'warning' : 'critical')
      : null;
    
    // 5. Build response
    const baseResponse = {
      id: dbJob.id,
      status: dbJob.status,
      total: dbJob.total,
      processed: dbJob.processed,
      currentEventId: dbJob.current_event_id,
      startedAt: dbJob.started_at.toISOString(),
      estimatedSecondsRemaining: dbJob.status === 'running'
        ? Math.max(0, Math.round((dbJob.total - dbJob.processed) * 3))
        : 0,
      summary: dbJob.summary as any || { published: 0, pending_review: 0, rejected: 0, failed: 0, incomplete: 0, archived: 0 },
      total_cost_usd: dbJob.total_cost_usd,
      last_updated_at: dbJob.last_heartbeat.toISOString(),
      completed_at: dbJob.completed_at?.toISOString() || null,
      heartbeat_age_seconds: heartbeatAgeSeconds,
      heartbeat_status: heartbeatStatus,
      redis_available: redisAvailable,
    };
    
    // Handle changed_since for efficient polling
    if (changed_since && typeof changed_since === 'string') {
      const sinceDate = new Date(changed_since);
      const lastUpdated = new Date(dbJob.last_heartbeat);
      
      if (lastUpdated <= sinceDate) {
        return res.json({
          success: true,
          data: {
            ...baseResponse,
            events: [],
            has_changes: false,
          },
        });
      }
      
      // Filter events to only changed ones
      const changedEvents = events.filter(e => 
        e.processing_status !== 'waiting' || 
        e.id === dbJob.current_event_id
      );
      
      return res.json({
        success: true,
        data: {
          ...baseResponse,
          events: changedEvents,
          has_changes: true,
        },
      });
    }
    
    // Return full response
    res.json({
      success: true,
      data: {
        ...baseResponse,
        events,
        has_changes: true,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/pending-ai-count - Get count of events waiting for AI processing
router.get('/pending-ai-count', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const count = await prisma.canonicalEvent.count({
      where: { status: 'pending_ai' }
    });
    
    res.json({
      success: true,
      data: { count }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// AI JOBS (Persistent Status Tracking)
// ============================================

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const STALE_NO_PROGRESS_MS = 2 * 60 * 1000; // 2 minutes when still 0 processed (stuck at first event)

// Helper: Check if a job is stale (no heartbeat for 5+ min, or no progress for 2+ min)
async function checkAndMarkStale(job: any): Promise<any> {
  if (job.status !== 'running') return job;
  
  const heartbeatAge = Date.now() - new Date(job.last_heartbeat).getTime();
  const noProgress = (job.processed ?? 0) === 0;
  const staleThreshold = noProgress ? STALE_NO_PROGRESS_MS : STALE_THRESHOLD_MS;
  
  if (heartbeatAge > staleThreshold) {
    await prisma.aiJob.update({
      where: { id: job.id },
      data: { status: 'stale' }
    });
    return { ...job, status: 'stale' };
  }
  return job;
}

// GET /api/admin/ai-jobs - List AI jobs (last 24h)
router.get('/ai-jobs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // Last 24h
    
    const [jobs, total] = await Promise.all([
      prisma.aiJob.findMany({
        where: { started_at: { gte: since } },
        take: Number(limit),
        skip: Number(offset),
        orderBy: { started_at: 'desc' },
      }),
      prisma.aiJob.count({ where: { started_at: { gte: since } } })
    ]);
    
    // Check for stale jobs
    const checkedJobs = await Promise.all(jobs.map(checkAndMarkStale));
    
    res.json({
      success: true,
      data: checkedJobs,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/ai-jobs/active - Get the currently running job (if any)
router.get('/ai-jobs/active', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Find running job with recent heartbeat
    let activeJob = await prisma.aiJob.findFirst({
      where: { status: 'running' },
      orderBy: { started_at: 'desc' },
    });
    
    if (!activeJob) {
      return res.json({
        success: true,
        data: null,
        message: 'No active job'
      });
    }
    
    // Check if stale
    activeJob = await checkAndMarkStale(activeJob);
    if (!activeJob) {
      return res.json({ success: true, data: null, message: 'No active job' });
    }
    // If stale, return null (no active job)
    if (activeJob.status === 'stale') {
      return res.json({
        success: true,
        data: null,
        message: 'Last job is stale',
        stale_job_id: activeJob.id
      });
    }
    
    // Try to get event details from Redis
    let events: AIJobEventDetail[] = [];
    if (redis && isRedisAvailable()) {
      const redisData = await redis.get(`${AI_JOB_PREFIX}${activeJob.id}`);
      if (redisData) {
        const parsed = JSON.parse(redisData);
        events = parsed.events || [];
      }
    }
    
    // Calculate heartbeat age for UI
    const heartbeatAgeMs = Date.now() - new Date(activeJob.last_heartbeat).getTime();
    const heartbeatAgeSeconds = Math.floor(heartbeatAgeMs / 1000);
    
    res.json({
      success: true,
      data: {
        ...activeJob,
        // Camelcase aliases for frontend compatibility
        startedAt: activeJob.started_at.toISOString(),
        currentEventId: activeJob.current_event_id,
        totalCostUsd: activeJob.total_cost_usd,
        events,
        heartbeat_age_seconds: heartbeatAgeSeconds,
        heartbeat_status: heartbeatAgeSeconds < 120 ? 'healthy' : heartbeatAgeSeconds < 300 ? 'warning' : 'critical',
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/ai-jobs/:id/cancel - Cancel a running job
router.post('/ai-jobs/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    
    const job = await prisma.aiJob.findUnique({ where: { id } });
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    
    if (job.status !== 'running' && job.status !== 'stale') {
      return res.status(400).json({ 
        success: false, 
        error: `Job cannot be cancelled (status: ${job.status})` 
      });
    }
    
    await prisma.aiJob.update({
      where: { id },
      data: { 
        status: 'cancelled',
        completed_at: new Date()
      }
    });
    
    // Clean up Redis if available
    if (redis && isRedisAvailable()) {
      await redis.del(`${AI_JOB_PREFIX}${id}`);
    }
    
    logger.info(`AI job ${id} cancelled`);
    
    res.json({
      success: true,
      message: 'Job cancelled'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/ai-jobs/:id - Get specific job by ID (with stale check)
router.get('/ai-jobs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    
    let job = await prisma.aiJob.findUnique({ where: { id } });
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    
    // Check if stale
    job = await checkAndMarkStale(job);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // Get event details from Redis
    let events: AIJobEventDetail[] = [];
    if (redis && isRedisAvailable()) {
      const redisData = await redis.get(`${AI_JOB_PREFIX}${id}`);
      if (redisData) {
        const parsed = JSON.parse(redisData);
        events = parsed.events || [];
      }
    }
    
    const heartbeatAgeMs = Date.now() - new Date(job.last_heartbeat).getTime();
    const heartbeatAgeSeconds = Math.floor(heartbeatAgeMs / 1000);
    
    res.json({
      success: true,
      data: {
        ...job,
        events,
        heartbeat_age_seconds: heartbeatAgeSeconds,
        heartbeat_status: job.status === 'running' 
          ? (heartbeatAgeSeconds < 120 ? 'healthy' : heartbeatAgeSeconds < 300 ? 'warning' : 'critical')
          : null,
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// AI WORKER PROXY ENDPOINTS
// ============================================

// GET /api/admin/ai-worker/health - Proxy to AI Worker health endpoint
router.get('/ai-worker/health', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const response = await fetch(`${AI_WORKER_URL}/health`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });
    
    if (!response.ok) {
      return res.json({
        success: false,
        error: `AI Worker returned ${response.status}`,
        data: { status: 'unhealthy' }
      });
    }
    
    const data = await response.json() as any;
    const workerStatus = data?.status;
    const isHealthy = workerStatus === 'healthy' || workerStatus === 'ok';
    
    res.json({
      success: true,
      data: {
        status: isHealthy ? 'healthy' : (workerStatus || 'unknown'),
        ...data
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`AI Worker health check failed: ${errorMessage}`);
    
    res.json({
      success: false,
      error: errorMessage,
      data: { status: 'unreachable' }
    });
  }
});

// GET /api/admin/ai-worker/diagnostics - Detailed diagnostics from AI Worker
router.get('/ai-worker/diagnostics', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Fetch both basic health and detailed readiness in parallel
    const [healthResponse, readyResponse, metricsResponse] = await Promise.all([
      fetch(`${AI_WORKER_URL}/health`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null),
      fetch(`${AI_WORKER_URL}/health/ready`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000), // Longer timeout for full check
      }).catch(() => null),
      fetch(`${AI_WORKER_URL}/metrics/health-summary`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null),
    ]);

    // Process responses
    const basicHealth = healthResponse?.ok ? await healthResponse.json() as any : null;
    const readiness = readyResponse?.ok ? await readyResponse.json() as any : null;
    const metrics = metricsResponse?.ok ? await metricsResponse.json() as any : null;

    // Build diagnostic response
    const diagnostics: any = {
      reachable: basicHealth !== null,
      timestamp: new Date().toISOString(),
      worker_url: AI_WORKER_URL,
    };

    if (basicHealth) {
      diagnostics.basic = {
        status: basicHealth.status,
        version: basicHealth.version,
        service: basicHealth.service,
      };
    }

    if (readiness) {
      diagnostics.status = readiness.status;
      diagnostics.checks = readiness.checks;
      diagnostics.config = readiness.config;
    } else {
      diagnostics.status = basicHealth ? 'unknown' : 'unreachable';
      diagnostics.checks = {};
    }

    if (metrics) {
      diagnostics.metrics = {
        queue_pending: metrics.indicators?.queue_pending || 0,
        dlq_count: metrics.indicators?.dlq_count || 0,
        ai_enabled: metrics.indicators?.ai_enabled ?? true,
        budget_status: metrics.indicators?.budget_status || 'unknown',
        issues: metrics.issues || [],
      };
    }

    res.json({
      success: true,
      data: diagnostics
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`AI Worker diagnostics failed: ${errorMessage}`);
    
    res.json({
      success: false,
      error: errorMessage,
      data: {
        reachable: false,
        status: 'error',
        timestamp: new Date().toISOString(),
        worker_url: AI_WORKER_URL,
      }
    });
  }
});

// GET /api/admin/ai-worker/stats - Get AI Worker processing statistics
router.get('/ai-worker/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Get today's start
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Count events processed today (events with EventScore created today)
    const processedToday = await prisma.eventScore.count({
      where: {
        scored_at: { gte: today }
      }
    });

    // Get processing statistics for success rate
    const last7Days = new Date();
    last7Days.setDate(last7Days.getDate() - 7);

    const recentScores = await prisma.eventScore.findMany({
      where: {
        scored_at: { gte: last7Days }
      },
      select: {
        family_fit_score: true,
        confidence: true,
      }
    });

    // Calculate success rate (events with confidence >= 0.5 that got a family_fit_score)
    const successfulProcessing = recentScores.filter(s => 
      s.confidence !== null && Number(s.confidence) >= 0.5 && s.family_fit_score !== null
    ).length;
    const successRate = recentScores.length > 0 
      ? Math.round((successfulProcessing / recentScores.length) * 100)
      : 0;

    // Average processing time not available (EventScore has no processing_time_ms)
    const avgProcessingTime = null;

    // Get last processing time for display
    const lastProcessed = await prisma.eventScore.findFirst({
      orderBy: { scored_at: 'desc' },
      select: { scored_at: true }
    });

    res.json({
      success: true,
      data: {
        processedToday,
        successRate,
        avgProcessingTime,
        totalLast7Days: recentScores.length,
        lastProcessedAt: lastProcessed?.scored_at || null
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/ai-worker/queue-stats - Proxy to AI Worker queue stats endpoint
router.get('/ai-worker/queue-stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const response = await fetch(`${AI_WORKER_URL}/crawl/queue-stats`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });
    
    if (!response.ok) {
      return res.json({
        success: false,
        error: `AI Worker returned ${response.status}`,
        data: null
      });
    }
    
    const data = await response.json();
    
    res.json({
      success: true,
      data
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`AI Worker queue-stats failed: ${errorMessage}`);
    
    res.json({
      success: false,
      error: errorMessage,
      data: null
    });
  }
});

// ============================================
// EVENT MAINTENANCE ENDPOINTS
// ============================================

// POST /api/admin/archive-past-events - Archive events with past start_datetime
router.post('/archive-past-events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dry_run } = req.query;
    const now = new Date();
    
    // Find all published events with past start_datetime
    const pastEvents = await prisma.canonicalEvent.findMany({
      where: {
        status: 'published',
        start_datetime: { lt: now },
        NOT: { start_datetime: null }
      },
      select: { id: true, title: true, start_datetime: true }
    });
    
    logger.info(`Found ${pastEvents.length} past published events to archive`);
    
    if (dry_run !== 'true' && pastEvents.length > 0) {
      await prisma.canonicalEvent.updateMany({
        where: { id: { in: pastEvents.map(e => e.id) } },
        data: { status: 'archived' }
      });
      logger.info(`Archived ${pastEvents.length} past events`);
    }
    
    res.json({
      success: true,
      archived_count: pastEvents.length,
      dry_run: dry_run === 'true',
      events: pastEvents.slice(0, 20) // Limit response size
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/fix-null-date-events - Set events without start_datetime to incomplete
router.post('/fix-null-date-events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dry_run } = req.query;
    
    // Find all published events with NULL start_datetime
    const nullDateEvents = await prisma.canonicalEvent.findMany({
      where: {
        status: 'published',
        start_datetime: null
      },
      select: { id: true, title: true }
    });
    
    logger.info(`Found ${nullDateEvents.length} published events without start_datetime`);
    
    if (dry_run !== 'true' && nullDateEvents.length > 0) {
      const result = await prisma.canonicalEvent.updateMany({
        where: {
          status: 'published',
          start_datetime: null
        },
        data: { status: 'incomplete' }
      });
      logger.info(`Set ${result.count} events without start_datetime to incomplete`);
    }
    
    res.json({
      success: true,
      updated_count: nullDateEvents.length,
      dry_run: dry_run === 'true',
      message: 'Events ohne Startdatum auf "incomplete" gesetzt',
      events: nullDateEvents.slice(0, 20) // Limit response size
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// EVENT DELETE ENDPOINT
// ============================================

// DELETE /api/admin/events/:id - Permanently delete an event
router.delete('/events/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const userId = req.user?.sub;

    // First fetch the event to verify it exists
    const existingEvent = await prisma.canonicalEvent.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        status: true,
        provider_id: true,
      }
    });

    if (!existingEvent) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    logger.info(`Admin ${userId} deleting event ${id}: "${existingEvent.title}" (status: ${existingEvent.status})`);

    // Delete related records in correct order (respecting foreign keys)
    await prisma.$transaction(async (tx) => {
      // 1. Delete event categories
      await tx.eventCategory.deleteMany({
        where: { event_id: id }
      });

      // 2. Delete event amenities
      await tx.eventAmenity.deleteMany({
        where: { event_id: id }
      });

      // 3. Delete event scores
      await tx.eventScore.deleteMany({
        where: { event_id: id }
      });

      // 4. Delete saved events (user bookmarks)
      await tx.savedEvent.deleteMany({
        where: { event_id: id }
      });

      // 5. Delete event revisions
      await tx.eventRevision.deleteMany({
        where: { event_id: id }
      });

      // 6. Delete event sources (link table)
      await tx.eventSource.deleteMany({
        where: { canonical_event_id: id }
      });

      // 7. Delete duplicate candidates referencing this event
      await tx.dupCandidate.deleteMany({
        where: {
          OR: [
            { event_a_id: id },
            { event_b_id: id }
          ]
        }
      });

      // 8. Delete raw event items linked to this event
      await tx.rawEventItem.deleteMany({
        where: { canonical_event_id: id }
      });

      // 9. Finally delete the event itself
      await tx.canonicalEvent.delete({
        where: { id }
      });
    });

    logger.info(`Event ${id} permanently deleted by admin ${userId}`);

    res.json({
      success: true,
      message: 'Event permanently deleted',
      data: {
        deleted_id: id,
        title: existingEvent.title,
      }
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/admin/events/bulk - Delete multiple events at once
router.delete('/events/bulk', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { ids } = req.body;
    const userId = req.user?.sub;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      throw createError('Event IDs required', 400, 'VALIDATION_ERROR');
    }

    if (ids.length > 100) {
      throw createError('Maximum 100 events per bulk delete', 400, 'VALIDATION_ERROR');
    }

    logger.info(`Admin ${userId} bulk deleting ${ids.length} events`);

    // Fetch events to verify they exist
    const existingEvents = await prisma.canonicalEvent.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true }
    });

    const existingIds = existingEvents.map(e => e.id);
    const notFoundIds = ids.filter(id => !existingIds.includes(id));

    // Delete related records for all events
    await prisma.$transaction(async (tx) => {
      await tx.eventCategory.deleteMany({ where: { event_id: { in: existingIds } } });
      await tx.eventAmenity.deleteMany({ where: { event_id: { in: existingIds } } });
      await tx.eventScore.deleteMany({ where: { event_id: { in: existingIds } } });
      await tx.savedEvent.deleteMany({ where: { event_id: { in: existingIds } } });
      await tx.eventRevision.deleteMany({ where: { event_id: { in: existingIds } } });
      await tx.eventSource.deleteMany({ where: { canonical_event_id: { in: existingIds } } });
      await tx.dupCandidate.deleteMany({
        where: {
          OR: [
            { event_a_id: { in: existingIds } },
            { event_b_id: { in: existingIds } }
          ]
        }
      });
      await tx.rawEventItem.deleteMany({ where: { canonical_event_id: { in: existingIds } } });
      await tx.canonicalEvent.deleteMany({ where: { id: { in: existingIds } } });
    });

    logger.info(`Bulk deleted ${existingIds.length} events by admin ${userId}`);

    res.json({
      success: true,
      message: `${existingIds.length} events permanently deleted`,
      data: {
        deleted_count: existingIds.length,
        deleted_ids: existingIds,
        not_found_ids: notFoundIds,
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/events/bulk-action - Perform bulk actions on multiple events
router.post('/events/bulk-action', requireAuth, requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { event_ids, action, params } = req.body;
    const userId = req.user?.sub;

    if (!event_ids || !Array.isArray(event_ids) || event_ids.length === 0) {
      throw createError('event_ids required', 400, 'VALIDATION_ERROR');
    }
    if (event_ids.length > 200) {
      throw createError('Maximum 200 events per bulk action', 400, 'VALIDATION_ERROR');
    }
    if (!['crawl', 'ai_rerun', 'reject', 'publish'].includes(action)) {
      throw createError('Invalid action. Must be: crawl, ai_rerun, reject, publish', 400, 'VALIDATION_ERROR');
    }

    const needCrawlFields = action === 'crawl';
    const events = await prisma.canonicalEvent.findMany({
      where: { id: { in: event_ids } },
      select: {
        id: true,
        title: true,
        status: true,
        booking_url: true,
        ...(needCrawlFields ? {
          field_fill_status: true,
          location_address: true,
          start_datetime: true,
          end_datetime: true,
          image_urls: true,
        } : {}),
        event_sources: {
          orderBy: { updated_at: 'desc' as const },
          select: {
            source_url: true,
            source: { select: { id: true, detail_page_config: true, url: true } },
          },
        },
      },
    });

    const results: { id: string; success: boolean; message: string }[] = [];

    if (action === 'reject') {
      const threshold = params?.threshold;
      for (const event of events) {
        await prisma.canonicalEvent.update({
          where: { id: event.id },
          data: {
            status: 'rejected',
            rejection_reason: threshold ? `Bulk reject: score < ${threshold}` : 'Bulk reject by admin',
          }
        });
        results.push({ id: event.id, success: true, message: 'Rejected' });
      }
    } else if (action === 'publish') {
      for (const event of events) {
        if (event.status === 'rejected') {
          results.push({ id: event.id, success: false, message: 'Already rejected' });
          continue;
        }
        await prisma.canonicalEvent.update({
          where: { id: event.id },
          data: { status: 'published' }
        });
        results.push({ id: event.id, success: true, message: 'Published' });
      }
    } else if (action === 'crawl') {
      const nowIso = new Date().toISOString();
      for (const event of events) {
        const url = event.booking_url || event.event_sources[0]?.source_url;
        if (!url) {
          results.push({ id: event.id, success: false, message: 'Keine URL vorhanden' });
          continue;
        }

        // Find source matching crawl URL domain
        let matchedSource: { id: string; detail_page_config: unknown; url: string | null } | null = null;
        try {
          const crawlDomain = new URL(url).hostname;
          matchedSource = event.event_sources
            .map((es: any) => es.source)
            .find((s: any) => s?.url && new URL(s.url).hostname === crawlDomain) || null;
        } catch { /* skip */ }
        if (!matchedSource) matchedSource = (event.event_sources[0] as any)?.source || null;

        const fieldsNeeded: string[] = [];
        if (!event.location_address || (typeof event.location_address === 'string' && !event.location_address.trim())) fieldsNeeded.push('location_address');
        if (!event.start_datetime) fieldsNeeded.push('start_datetime');
        if (!event.end_datetime) fieldsNeeded.push('end_datetime');
        if (!Array.isArray(event.image_urls) || event.image_urls.length === 0) fieldsNeeded.push('image_url');

        if (fieldsNeeded.length === 0) {
          results.push({ id: event.id, success: true, message: 'Keine fehlenden Felder' });
          continue;
        }
        try {
          const crawlRes = await fetch(`${AI_WORKER_URL}/crawl/single-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url,
              fields_needed: fieldsNeeded,
              detail_page_config: matchedSource?.detail_page_config || null,
              source_id: matchedSource?.id || null,
            }),
            signal: AbortSignal.timeout(20000),
          });
          const crawlResult = await crawlRes.json() as { success: boolean; fields_found: Record<string, unknown>; error?: string };
          if (!crawlRes.ok || !crawlResult.success) {
            results.push({ id: event.id, success: false, message: crawlResult.error || 'Crawl failed' });
            continue;
          }
          const existingFieldFillStatus = (event.field_fill_status as Record<string, FieldFillStatusValue>) || {};
          const eventUpdate: Record<string, unknown> = {};
          if (crawlResult.fields_found?.location_address) {
            eventUpdate.location_address = crawlResult.fields_found.location_address;
            existingFieldFillStatus['location_address'] = { status: 'filled', source: 'crawl', last_attempt: nowIso };
          }
          if (crawlResult.fields_found?.start_datetime) {
            try {
              eventUpdate.start_datetime = new Date(crawlResult.fields_found.start_datetime as string);
              existingFieldFillStatus['start_datetime'] = { status: 'filled', source: 'crawl', last_attempt: nowIso };
            } catch { /* ignore */ }
          }
          if (crawlResult.fields_found?.end_datetime) {
            try {
              eventUpdate.end_datetime = new Date(crawlResult.fields_found.end_datetime as string);
              existingFieldFillStatus['end_datetime'] = { status: 'filled', source: 'crawl', last_attempt: nowIso };
            } catch { /* ignore */ }
          }
          if (Object.keys(eventUpdate).length > 0) {
            await prisma.canonicalEvent.update({
              where: { id: event.id },
              data: { ...eventUpdate, field_fill_status: existingFieldFillStatus },
            });
          }
          const updatedCount = Object.keys(eventUpdate).length;
          results.push({ id: event.id, success: true, message: updatedCount ? `${updatedCount} Felder in DB übernommen` : `${Object.keys(crawlResult.fields_found || {}).length} Felder gefunden (keine neuen)` });
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          results.push({ id: event.id, success: false, message: errMsg || 'Crawl error' });
        }
      }
    } else if (action === 'ai_rerun') {
      await prisma.canonicalEvent.updateMany({
        where: { id: { in: event_ids } },
        data: { status: 'pending_ai' }
      });
      results.push(...events.map(e => ({ id: e.id, success: true, message: 'Set to pending_ai' })));
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    logger.info(`Bulk action "${action}" on ${events.length} events by admin ${userId}`);

    if (userId) {
      try {
        await logAdminAction({
          userId,
          action: AuditAction.UPDATE,
          entityType: 'bulk_events',
          entityId: (params?.source_id as string) || 'global',
          entityName: `Bulk ${action}`,
          metadata: {
            action,
            event_count: events.length,
            source_id: params?.source_id ?? null,
            result_summary: { succeeded, failed },
          },
          req,
        });
      } catch (auditErr) {
        logger.warn('Bulk action audit log failed: ' + (auditErr instanceof Error ? auditErr.message : String(auditErr)));
      }
    }

    res.json({
      success: true,
      data: {
        action,
        total: event_ids.length,
        processed: results.length,
        succeeded,
        failed,
        results,
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/test-selectors - Test detail_page_config selectors against a URL
// Used by the Admin "Selektoren testen" button on sources page
router.post('/test-selectors', requireAuth, requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { url, detail_page_config } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'url is required' });
    }

    const crawlRes = await fetch(`${AI_WORKER_URL}/crawl/single-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        detail_page_config: detail_page_config || null,
        use_ai: true,
      }),
      signal: AbortSignal.timeout(25000),
    });
    const crawlResult = await crawlRes.json() as { success?: boolean; fields_found?: Record<string, unknown>; fields_missing?: string[]; field_provenance?: Record<string, unknown>; suggested_selectors?: Record<string, unknown>; extraction_method?: string; error?: string };

    res.json({
      success: crawlResult.success ?? true,
      data: crawlResult,
    });
  } catch (error: unknown) {
    logger.error('test-selectors failed:', error);
    const message = error instanceof Error ? error.message : 'Test fehlgeschlagen';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
