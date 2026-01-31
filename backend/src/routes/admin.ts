import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { approveRevision, rejectRevision } from '../lib/eventRevision.js';
import { sendEventApprovedEmail, sendEventRejectedEmail } from '../lib/email.js';

const router = Router();

// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);

// GET /api/admin/stats - Dashboard statistics
router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [
      totalEvents,
      publishedEvents,
      pendingReview,
      todayImports,
      sources
    ] = await Promise.all([
      prisma.canonicalEvent.count(),
      prisma.canonicalEvent.count({ where: { status: 'published' } }),
      prisma.canonicalEvent.count({ where: { status: 'pending_review' } }),
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
      })
    ]);

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
          today_imports: todayImports
        },
        sources: sourceHealth
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/review-queue - Events pending review
router.get('/review-queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status = 'pending_review', limit = 20, offset = 0 } = req.query;

    const where: any = {};
    
    if (status !== 'all') {
      where.status = status;
    } else {
      where.status = { in: ['pending_review', 'pending_ai', 'incomplete'] };
    }

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

    res.json({
      success: true,
      data: events,
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

// POST /api/admin/review/:id/approve - Approve an event
router.post('/review/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const event = await prisma.canonicalEvent.update({
      where: { id },
      data: {
        status: 'published',
        is_verified: true,
        last_verified_at: new Date()
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

    const updateData: any = {
      status: 'published',
      is_verified: true,
      last_verified_at: new Date(),
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

    res.json({
      success: true,
      message: 'Event edited and approved',
      data: event,
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

// PATCH /api/admin/ingest-runs/:id - Update ingest run (called by AI-Worker)
// This endpoint is used by the AI-Worker to report progress and completion
router.patch('/ingest-runs/:id', async (req: Request, res: Response, next: NextFunction) => {
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

    // Build update data
    const updateData: Record<string, any> = {};
    
    if (status !== undefined) updateData.status = status;
    if (events_found !== undefined) updateData.events_found = events_found;
    if (events_created !== undefined) updateData.events_created = events_created;
    if (events_updated !== undefined) updateData.events_updated = events_updated;
    if (events_skipped !== undefined) updateData.events_skipped = events_skipped;
    if (error_message !== undefined) updateData.error_message = error_message;
    if (error_details !== undefined) updateData.error_details = error_details;
    if (needs_attention !== undefined) updateData.needs_attention = needs_attention;
    
    // Handle finished_at
    if (finished_at === 'now') {
      updateData.finished_at = new Date();
    } else if (finished_at) {
      updateData.finished_at = new Date(finished_at);
    }

    // If status is success/partial/failed and no finished_at, set it
    if (['success', 'partial', 'failed'].includes(status) && !updateData.finished_at) {
      updateData.finished_at = new Date();
    }

    // Auto-set needs_attention for failed runs
    if (status === 'failed' && needs_attention === undefined) {
      updateData.needs_attention = true;
    }

    const run = await prisma.ingestRun.update({
      where: { id },
      data: updateData,
      include: {
        source: {
          select: { id: true, name: true }
        }
      }
    });

    // Also update the source health status based on the result
    if (run.source_id && ['success', 'partial', 'failed'].includes(status)) {
      const sourceUpdate: Record<string, any> = {};
      
      if (status === 'success') {
        sourceUpdate.last_success_at = new Date();
        sourceUpdate.consecutive_failures = 0;
        sourceUpdate.health_status = 'healthy';
        
        // Update avg_events_per_fetch
        if (events_found !== undefined) {
          const source = await prisma.source.findUnique({ where: { id: run.source_id } });
          if (source) {
            const currentAvg = source.avg_events_per_fetch || 0;
            // Simple moving average
            sourceUpdate.avg_events_per_fetch = currentAvg === 0 
              ? events_found 
              : (currentAvg * 0.7 + events_found * 0.3);
          }
        }
      } else if (status === 'failed') {
        sourceUpdate.last_failure_at = new Date();
        
        // Increment consecutive failures
        const source = await prisma.source.findUnique({ where: { id: run.source_id } });
        if (source) {
          const failures = (source.consecutive_failures || 0) + 1;
          sourceUpdate.consecutive_failures = failures;
          
          // Update health status based on failure count
          if (failures >= 5) {
            sourceUpdate.health_status = 'dead';
          } else if (failures >= 3) {
            sourceUpdate.health_status = 'failing';
          } else {
            sourceUpdate.health_status = 'degraded';
          }
        }
      } else if (status === 'partial') {
        sourceUpdate.last_success_at = new Date();
        sourceUpdate.health_status = 'degraded';
      }
      
      if (Object.keys(sourceUpdate).length > 0) {
        await prisma.source.update({
          where: { id: run.source_id },
          data: sourceUpdate
        });
      }
    }

    res.json({
      success: true,
      message: 'Ingest run updated',
      data: run
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

export default router;
