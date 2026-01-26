import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';

const router = Router();

// TODO: Add auth middleware for admin routes

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
    const { reason } = req.body;

    const event = await prisma.canonicalEvent.update({
      where: { id },
      data: {
        status: 'rejected'
      }
    });

    // TODO: Log rejection reason

    res.json({
      success: true,
      message: 'Event rejected',
      data: event
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
    const conflicts = eventsWithMultipleSources.filter(e => 
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

export default router;
