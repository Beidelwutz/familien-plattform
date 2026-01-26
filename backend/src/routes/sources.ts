import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';

const router = Router();

// GET /api/sources - List all sources (admin)
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sources = await prisma.source.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: {
            event_sources: true,
          }
        }
      }
    });

    res.json({
      success: true,
      data: sources,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/sources/health - Get source health status
router.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sources = await prisma.source.findMany({
      where: { is_active: true },
      select: {
        id: true,
        name: true,
        type: true,
        health_status: true,
        last_success_at: true,
        last_failure_at: true,
        consecutive_failures: true,
        avg_events_per_fetch: true,
        expected_event_count_min: true,
      },
      orderBy: [
        { health_status: 'asc' },
        { name: 'asc' }
      ]
    });

    const summary = {
      total: sources.length,
      healthy: sources.filter(s => s.health_status === 'healthy').length,
      degraded: sources.filter(s => s.health_status === 'degraded').length,
      failing: sources.filter(s => s.health_status === 'failing').length,
      dead: sources.filter(s => s.health_status === 'dead').length,
    };

    res.json({
      success: true,
      data: {
        summary,
        sources,
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/sources/:id - Get single source with recent fetches
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const source = await prisma.source.findUnique({
      where: { id },
      include: {
        compliance: true,
        fetch_logs: {
          orderBy: { started_at: 'desc' },
          take: 10,
        },
        _count: {
          select: {
            event_sources: true,
          }
        }
      }
    });

    if (!source) {
      throw createError('Source not found', 404, 'NOT_FOUND');
    }

    res.json({
      success: true,
      data: source,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/sources/:id/trigger - Manually trigger a source fetch
router.post('/:id/trigger', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const source = await prisma.source.findUnique({
      where: { id }
    });

    if (!source) {
      throw createError('Source not found', 404, 'NOT_FOUND');
    }

    // TODO: Queue fetch job to Redis
    // For now, just return success
    
    res.json({
      success: true,
      message: 'Fetch job queued',
      data: {
        source_id: id,
        queued_at: new Date().toISOString(),
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
