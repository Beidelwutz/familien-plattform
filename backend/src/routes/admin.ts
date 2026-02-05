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

const AI_WORKER_URL = process.env.AI_WORKER_URL || 'http://localhost:5000';

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

interface AIJobStatus {
  id: string;
  status: 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  currentEvent: { id: string; title: string } | null;
  startedAt: string;
  estimatedSecondsRemaining: number | null;
  results: Array<{ id: string; title: string; status?: string; familyFit?: number; error?: string }>;
  summary: { published: number; pending_review: number; rejected: number; failed: number };
}

const AI_JOB_PREFIX = 'ai-job:';
const AI_JOB_TTL = 3600; // 1 hour

async function updateAIJobStatus(jobId: string, update: Partial<AIJobStatus>): Promise<void> {
  if (!redis || !isRedisAvailable()) return;
  
  const key = `${AI_JOB_PREFIX}${jobId}`;
  const existing = await redis.get(key);
  const current: AIJobStatus = existing ? JSON.parse(existing) : {};
  const updated = { ...current, ...update };
  
  await redis.setex(key, AI_JOB_TTL, JSON.stringify(updated));
}

async function getAIJobStatus(jobId: string): Promise<AIJobStatus | null> {
  if (!redis || !isRedisAvailable()) return null;
  
  const key = `${AI_JOB_PREFIX}${jobId}`;
  const data = await redis.get(key);
  
  return data ? JSON.parse(data) : null;
}

// POST /api/admin/process-pending-ai - Process events with pending_ai status through AI Worker
router.post('/process-pending-ai', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit = 50 } = req.query;
    
    // Get events with pending_ai status
    const pendingEvents = await prisma.canonicalEvent.findMany({
      where: { 
        status: 'pending_ai',
      },
      take: Number(limit),
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
        is_indoor: true,
        is_outdoor: true,
      }
    });
    
    if (pendingEvents.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No pending events to process', 
        processed: 0,
        jobId: null,
        summary: { published: 0, pending_review: 0, rejected: 0, failed: 0 }
      });
    }
    
    // Generate job ID and initialize status
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    
    const initialStatus: AIJobStatus = {
      id: jobId,
      status: 'running',
      total: pendingEvents.length,
      processed: 0,
      currentEvent: null,
      startedAt,
      estimatedSecondsRemaining: pendingEvents.length * 3, // ~3s per event estimate
      results: [],
      summary: { published: 0, pending_review: 0, rejected: 0, failed: 0 },
    };
    
    // Store initial status in Redis (if available)
    if (redis && isRedisAvailable()) {
      await redis.setex(`${AI_JOB_PREFIX}${jobId}`, AI_JOB_TTL, JSON.stringify(initialStatus));
    }
    
    logger.info(`Starting AI job ${jobId} for ${pendingEvents.length} pending_ai events`);
    
    // Return immediately with job ID
    res.json({
      success: true,
      jobId,
      total: pendingEvents.length,
      message: 'Processing started',
    });
    
    // Process events in the background
    setImmediate(async () => {
      const results: AIJobStatus['results'] = [];
      const summary = { published: 0, pending_review: 0, rejected: 0, failed: 0 };
      const startTime = Date.now();
      
      for (let i = 0; i < pendingEvents.length; i++) {
        const event = pendingEvents[i];
        
        // Update current event status
        await updateAIJobStatus(jobId, {
          processed: i,
          currentEvent: { id: event.id, title: event.title || 'Unbekannt' },
          estimatedSecondsRemaining: i > 0 
            ? Math.round(((Date.now() - startTime) / i) * (pendingEvents.length - i) / 1000)
            : (pendingEvents.length - i) * 3,
        });
        
        try {
          // Step 1: Classification
          const classifyRes = await fetch(`${AI_WORKER_URL}/classify/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: event.title,
              description: event.description_short || event.description_long || '',
              location_address: event.location_address || '',
              price_min: event.price_min ? Number(event.price_min) : null,
              price_max: event.price_max ? Number(event.price_max) : null,
              is_indoor: event.is_indoor,
              is_outdoor: event.is_outdoor,
            }),
          });
          
          if (!classifyRes.ok) {
            const errorText = await classifyRes.text();
            throw new Error(`Classification failed: ${classifyRes.status} - ${errorText}`);
          }
          const classification = await classifyRes.json();
          
          // Step 2: Scoring
          const scoreRes = await fetch(`${AI_WORKER_URL}/classify/score`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: event.title,
              description: event.description_short || event.description_long || '',
              location_address: event.location_address || '',
            }),
          });
          
          if (!scoreRes.ok) {
            const errorText = await scoreRes.text();
            throw new Error(`Scoring failed: ${scoreRes.status} - ${errorText}`);
          }
          const scores = await scoreRes.json();
          
          // Step 3: Determine new status based on AI scores
          let newStatus = determineStatusFromAIScores(
            scores.family_fit_score,
            classification.confidence
          );
          
          // Step 3.5: Handle extracted datetime/location from AI
          // Check if AI extracted datetime/location with high confidence
          const extractedStartDatetime = classification.extracted_start_datetime;
          const extractedEndDatetime = classification.extracted_end_datetime;
          const extractedLocationAddress = classification.extracted_location_address;
          const extractedLocationDistrict = classification.extracted_location_district;
          const datetimeConfidence = classification.datetime_confidence || 0;
          const locationConfidence = classification.location_confidence || 0;
          
          // Use event's existing datetime or AI-extracted (if confidence >= 0.7)
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
          
          // Step 4: Update the event with AI-generated data
          // Build update data with extracted fields (only if not already present and confidence >= 0.7)
          const updateData: Record<string, any> = {
            status: newStatus,
            age_min: classification.age_min ?? undefined,
            age_max: classification.age_max ?? undefined,
            age_rating: classification.age_rating ?? undefined,
            is_indoor: classification.is_indoor,
            is_outdoor: classification.is_outdoor,
            // AI-generated summaries
            ai_summary_short: classification.ai_summary_short ?? undefined,
            ai_fit_blurb: classification.ai_fit_blurb ?? undefined,
            ai_summary_highlights: classification.ai_summary_highlights ?? undefined,
            ai_summary_confidence: classification.summary_confidence ?? undefined,
            // Age fit buckets
            age_fit_0_2: classification.age_fit_buckets?.["0_2"] ?? undefined,
            age_fit_3_5: classification.age_fit_buckets?.["3_5"] ?? undefined,
            age_fit_6_9: classification.age_fit_buckets?.["6_9"] ?? undefined,
            age_fit_10_12: classification.age_fit_buckets?.["10_12"] ?? undefined,
            age_fit_13_15: classification.age_fit_buckets?.["13_15"] ?? undefined,
            // AI flags
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
          
          await prisma.canonicalEvent.update({
            where: { id: event.id },
            data: updateData
          });
          
          // Step 5: Create/update EventScore
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
          
          // Step 6: Add categories if provided
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
          
          // Update summary
          if (newStatus === 'published') summary.published++;
          else if (newStatus === 'pending_review') summary.pending_review++;
          else if (newStatus === 'rejected') summary.rejected++;
          
          results.push({ 
            id: event.id, 
            title: event.title || 'Unbekannt', 
            status: newStatus, 
            familyFit: scores.family_fit_score 
          });
          
          logger.info(`Processed event ${event.id}: ${newStatus} (family_fit: ${scores.family_fit_score}, confidence: ${classification.confidence})`);
          
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          summary.failed++;
          results.push({ 
            id: event.id, 
            title: event.title || 'Unbekannt', 
            error: errorMessage 
          });
          logger.error(`Failed to process event ${event.id}: ${errorMessage}`);
        }
        
        // Update progress after each event
        await updateAIJobStatus(jobId, {
          processed: i + 1,
          results: [...results],
          summary: { ...summary },
        });
      }
      
      // Mark job as completed
      await updateAIJobStatus(jobId, {
        status: 'completed',
        processed: pendingEvents.length,
        currentEvent: null,
        estimatedSecondsRemaining: 0,
        results,
        summary,
      });
      
      logger.info(`AI job ${jobId} completed: ${JSON.stringify(summary)}`);
    });
    
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/ai-job-status/:jobId - Get status of an AI processing job
router.get('/ai-job-status/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { jobId } = req.params;
    
    if (!redis || !isRedisAvailable()) {
      return res.status(503).json({
        success: false,
        error: 'Redis not available for job status tracking',
      });
    }
    
    const status = await getAIJobStatus(jobId);
    
    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Job not found or expired',
      });
    }
    
    res.json({
      success: true,
      data: status,
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
    
    const data = await response.json();
    
    res.json({
      success: true,
      data: {
        status: 'healthy',
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
    const basicHealth = healthResponse?.ok ? await healthResponse.json() : null;
    const readiness = readyResponse?.ok ? await readyResponse.json() : null;
    const metrics = metricsResponse?.ok ? await metricsResponse.json() : null;

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
        processing_time_ms: true,
      }
    });

    // Calculate success rate (events with confidence >= 0.5 that got a family_fit_score)
    const successfulProcessing = recentScores.filter(s => 
      s.confidence !== null && s.confidence >= 0.5 && s.family_fit_score !== null
    ).length;
    const successRate = recentScores.length > 0 
      ? Math.round((successfulProcessing / recentScores.length) * 100)
      : 0;

    // Calculate average processing time
    const timesWithValues = recentScores
      .map(s => s.processing_time_ms)
      .filter((t): t is number => t !== null && t > 0);
    const avgProcessingTime = timesWithValues.length > 0
      ? Math.round(timesWithValues.reduce((a, b) => a + b, 0) / timesWithValues.length)
      : null;

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

export default router;
