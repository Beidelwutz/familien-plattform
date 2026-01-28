import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { approveRevision, rejectRevision } from '../lib/eventRevision.js';

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
      }
    });

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
      }
    });

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
      data: { needs_attention: false }
    });

    res.json({
      success: true,
      message: 'Run acknowledged'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
