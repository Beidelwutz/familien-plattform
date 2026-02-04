import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import cronParser from 'cron-parser';

const router = Router();

const AI_WORKER_URL = process.env.AI_WORKER_URL || 'http://localhost:5000';
const CRON_SECRET = process.env.CRON_SECRET || '';

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
      healthy: sources.filter((s: { health_status: string }) => s.health_status === 'healthy').length,
      degraded: sources.filter((s: { health_status: string }) => s.health_status === 'degraded').length,
      failing: sources.filter((s: { health_status: string }) => s.health_status === 'failing').length,
      dead: sources.filter((s: { health_status: string }) => s.health_status === 'dead').length,
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
router.post('/:id/trigger', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const source = await prisma.source.findUnique({
      where: { id }
    });

    if (!source) {
      throw createError('Source not found', 404, 'NOT_FOUND');
    }

    if (!source.url) {
      throw createError('Source has no URL configured', 400, 'VALIDATION_ERROR');
    }

    // Create an ingest run entry
    const ingestRun = await prisma.ingestRun.create({
      data: {
        correlation_id: `manual-${Date.now()}`,
        source_id: id,
        status: 'running',
      }
    });

    // Update source last_fetch_at
    await prisma.source.update({
      where: { id },
      data: { last_fetch_at: new Date() }
    });

    // Trigger AI-Worker crawl job
    const workerUrl = `${AI_WORKER_URL}/crawl/trigger`;
    try {
      const workerResponse = await fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source_id: id,
          source_url: source.url,
          source_type: source.type,
          ingest_run_id: ingestRun.id,
        }),
        signal: AbortSignal.timeout(15000), // 15s timeout
      });

      if (!workerResponse.ok) {
        const errorText = await workerResponse.text();
        logger.error(`AI-Worker crawl trigger failed: ${errorText}`);
        
        // Update ingest run with error
        await prisma.ingestRun.update({
          where: { id: ingestRun.id },
          data: {
            status: 'failed',
            finished_at: new Date(),
            error_message: `AI-Worker error: ${workerResponse.status}`,
            needs_attention: true,
          }
        });
        
        throw createError(`AI-Worker error: ${workerResponse.status}`, 502, 'WORKER_ERROR');
      }

      const workerData = await workerResponse.json();
      logger.info(`Crawl job triggered for source ${id}: ${JSON.stringify(workerData)}`);
    } catch (fetchError: any) {
      if (fetchError.code === 'WORKER_ERROR') {
        throw fetchError;
      }
      
      const isTimeout = fetchError.name === 'AbortError' || fetchError.message?.includes('timeout');
      const hint = `AI-Worker unter ${AI_WORKER_URL} starten: im Ordner ai-worker "start.bat" ausführen oder "python -m src.main" (Port 5000).`;
      const errorDetail = isTimeout
        ? 'Timeout – Worker antwortet nicht innerhalb von 15 Sekunden.'
        : fetchError.message || 'Verbindung fehlgeschlagen';
      
      logger.error(`Failed to reach AI-Worker at ${workerUrl}: ${errorDetail}`);
      
      // Update ingest run - worker unreachable
      await prisma.ingestRun.update({
        where: { id: ingestRun.id },
        data: {
          status: 'failed',
          finished_at: new Date(),
          error_message: `AI-Worker unreachable: ${errorDetail}. ${hint}`,
          needs_attention: true,
        }
      });
      
      throw createError(
        `AI-Worker nicht erreichbar (${AI_WORKER_URL}). Bitte AI-Worker starten.`,
        503,
        'WORKER_UNAVAILABLE'
      );
    }
    
    res.json({
      success: true,
      message: 'Fetch job queued',
      data: {
        source_id: id,
        ingest_run_id: ingestRun.id,
        queued_at: new Date().toISOString(),
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// SOURCE CRUD (Admin only)
// ============================================

const validateSource = [
  body('name').isString().isLength({ min: 2, max: 200 }).withMessage('name required (2-200 chars)'),
  body('type').isIn(['api', 'rss', 'ics', 'scraper', 'partner', 'manual']).withMessage('type must be valid SourceType'),
  body('url').optional().isURL().withMessage('url must be valid URL'),
  body('schedule_cron').optional().isString().isLength({ max: 50 }),
  body('priority').optional().isInt({ min: 1, max: 5 }),
  body('rate_limit_ms').optional().isInt({ min: 0 }),
  body('expected_event_count_min').optional().isInt({ min: 0 }),
  body('scrape_allowed').optional().isBoolean(),
  body('notes').optional().isString(),
];

// POST /api/sources - Create a new source (admin only)
router.post('/', requireAuth, requireAdmin, validateSource, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error: ' + errors.array().map(e => e.msg).join(', '), 400, 'VALIDATION_ERROR');
    }

    const {
      name,
      type,
      url,
      schedule_cron,
      priority,
      rate_limit_ms,
      expected_event_count_min,
      scrape_allowed,
      notes,
    } = req.body;

    // Create source
    const source = await prisma.source.create({
      data: {
        name,
        type,
        url: url || null,
        schedule_cron: schedule_cron || null,
        priority: priority || 3,
        rate_limit_ms: rate_limit_ms || 5000,
        expected_event_count_min: expected_event_count_min || null,
        scrape_allowed: scrape_allowed !== false,
        notes: notes || null,
        health_status: 'unknown',
      }
    });

    // Create compliance entry
    await prisma.sourceCompliance.create({
      data: {
        source_id: source.id,
        partnership_status: 'none',
      }
    });

    res.status(201).json({
      success: true,
      message: 'Source created',
      data: source,
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/sources/:id - Update a source (admin only)
router.put('/:id', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const source = await prisma.source.findUnique({ where: { id } });
    if (!source) {
      throw createError('Source not found', 404, 'NOT_FOUND');
    }

    const allowedFields = [
      'name', 'type', 'url', 'schedule_cron', 'priority',
      'rate_limit_ms', 'expected_event_count_min', 'scrape_allowed',
      'notes', 'is_active', 'health_status',
    ];

    const updateData: Record<string, any> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    if (Object.keys(updateData).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const updated = await prisma.source.update({
      where: { id },
      data: updateData,
    });

    res.json({
      success: true,
      message: 'Source updated',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/sources/:id - Partial update
router.patch('/:id', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const source = await prisma.source.findUnique({ where: { id } });
    if (!source) {
      throw createError('Source not found', 404, 'NOT_FOUND');
    }

    const allowedFields = [
      'name', 'type', 'url', 'schedule_cron', 'priority',
      'rate_limit_ms', 'expected_event_count_min', 'scrape_allowed',
      'notes', 'is_active', 'health_status',
    ];

    const updateData: Record<string, any> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    if (Object.keys(updateData).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const updated = await prisma.source.update({
      where: { id },
      data: updateData,
    });

    res.json({
      success: true,
      message: 'Source updated',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/sources/:id - Soft-delete a source (admin only)
router.delete('/:id', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { hard } = req.query; // ?hard=true for actual delete

    const source = await prisma.source.findUnique({ where: { id } });
    if (!source) {
      throw createError('Source not found', 404, 'NOT_FOUND');
    }

    if (hard === 'true') {
      // Hard delete - remove source and all related data
      await prisma.$transaction([
        prisma.sourceFetchLog.deleteMany({ where: { source_id: id } }),
        prisma.sourceCompliance.deleteMany({ where: { source_id: id } }),
        prisma.eventSource.deleteMany({ where: { source_id: id } }),
        prisma.ingestRun.deleteMany({ where: { source_id: id } }),
        prisma.source.delete({ where: { id } }),
      ]);

      res.json({
        success: true,
        message: 'Source permanently deleted',
      });
    } else {
      // Soft delete - just deactivate
      await prisma.source.update({
        where: { id },
        data: { is_active: false },
      });

      res.json({
        success: true,
        message: 'Source deactivated',
      });
    }
  } catch (error) {
    next(error);
  }
});

// PUT /api/sources/:id/compliance - Update source compliance info (admin only)
router.put('/:id/compliance', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const source = await prisma.source.findUnique({ where: { id } });
    if (!source) {
      throw createError('Source not found', 404, 'NOT_FOUND');
    }

    const {
      robots_txt_allows,
      tos_allows_scraping,
      contact_attempted,
      partnership_status,
      legal_notes,
    } = req.body;

    const compliance = await prisma.sourceCompliance.upsert({
      where: { source_id: id },
      update: {
        robots_txt_allows: robots_txt_allows ?? undefined,
        robots_txt_checked_at: robots_txt_allows !== undefined ? new Date() : undefined,
        tos_allows_scraping: tos_allows_scraping ?? undefined,
        tos_reviewed_at: tos_allows_scraping !== undefined ? new Date() : undefined,
        contact_attempted: contact_attempted ?? undefined,
        partnership_status: partnership_status ?? undefined,
        legal_notes: legal_notes ?? undefined,
      },
      create: {
        source_id: id,
        robots_txt_allows: robots_txt_allows ?? null,
        robots_txt_checked_at: robots_txt_allows !== undefined ? new Date() : null,
        tos_allows_scraping: tos_allows_scraping ?? null,
        tos_reviewed_at: tos_allows_scraping !== undefined ? new Date() : null,
        contact_attempted: contact_attempted ?? false,
        partnership_status: partnership_status ?? 'none',
        legal_notes: legal_notes ?? null,
      }
    });

    res.json({
      success: true,
      message: 'Compliance info updated',
      data: compliance,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// CRON ENDPOINTS
// ============================================

/**
 * Helper function to trigger a source fetch (used by cron and manual trigger)
 */
async function triggerSourceFetchInternal(sourceId: string, source: { url: string | null; type: string }): Promise<{ ingestRunId: string; success: boolean; error?: string }> {
  if (!source.url) {
    return { ingestRunId: '', success: false, error: 'No URL configured' };
  }

  const ingestRun = await prisma.ingestRun.create({
    data: {
      correlation_id: `cron-${Date.now()}`,
      source_id: sourceId,
      status: 'running',
    }
  });

  const workerUrl = `${AI_WORKER_URL}/crawl/trigger`;
  try {
    const workerResponse = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_id: sourceId,
        source_url: source.url,
        source_type: source.type,
        ingest_run_id: ingestRun.id,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!workerResponse.ok) {
      await prisma.ingestRun.update({
        where: { id: ingestRun.id },
        data: {
          status: 'failed',
          finished_at: new Date(),
          error_message: `AI-Worker error: ${workerResponse.status}`,
          needs_attention: true,
        }
      });
      return { ingestRunId: ingestRun.id, success: false, error: `Worker error: ${workerResponse.status}` };
    }

    return { ingestRunId: ingestRun.id, success: true };
  } catch (error: any) {
    const hint = `AI-Worker unter ${AI_WORKER_URL} starten (z.B. ai-worker/start.bat).`;
    const errorDetail = error.name === 'AbortError' ? 'Timeout (15s)' : (error.message || 'Verbindung fehlgeschlagen');
    await prisma.ingestRun.update({
      where: { id: ingestRun.id },
      data: {
        status: 'failed',
        finished_at: new Date(),
        error_message: `AI-Worker unreachable: ${errorDetail}. ${hint}`,
        needs_attention: true,
      }
    });
    return { ingestRunId: ingestRun.id, success: false, error: error.message };
  }
}

/**
 * Calculate next fetch time based on cron expression
 */
function calculateNextFetch(cronExpression: string | null): Date {
  if (!cronExpression) {
    // Default: 6 hours from now
    return new Date(Date.now() + 6 * 60 * 60 * 1000);
  }
  
  try {
    const interval = cronParser.parseExpression(cronExpression);
    return interval.next().toDate();
  } catch (error) {
    // Invalid cron expression, default to 6 hours
    return new Date(Date.now() + 6 * 60 * 60 * 1000);
  }
}

// POST /api/sources/cron/check - Check and trigger due sources (called by Vercel cron)
router.post('/cron/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Verify cron secret (Vercel sends this in Authorization header)
    const authHeader = req.headers.authorization;
    const providedSecret = authHeader?.replace('Bearer ', '') || req.query.secret;
    
    if (CRON_SECRET && providedSecret !== CRON_SECRET) {
      throw createError('Invalid cron secret', 401, 'UNAUTHORIZED');
    }

    const now = new Date();
    
    // Find all active sources that are due for a fetch
    const dueSources = await prisma.source.findMany({
      where: {
        is_active: true,
        url: { not: null },
        OR: [
          { next_fetch_at: { lte: now } },
          { next_fetch_at: null, last_fetch_at: null }, // Never fetched
          { 
            next_fetch_at: null, 
            last_fetch_at: { lte: new Date(now.getTime() - 6 * 60 * 60 * 1000) } // >6h ago
          },
        ]
      },
      select: {
        id: true,
        name: true,
        url: true,
        type: true,
        schedule_cron: true,
      },
      orderBy: { priority: 'asc' }, // Higher priority (lower number) first
      take: 10, // Process max 10 per cron run to avoid timeout
    });

    logger.info(`Cron check: Found ${dueSources.length} sources due for fetch`);

    const results: { sourceId: string; name: string; success: boolean; error?: string }[] = [];

    for (const source of dueSources) {
      const result = await triggerSourceFetchInternal(source.id, source);
      
      // Update next_fetch_at regardless of success
      await prisma.source.update({
        where: { id: source.id },
        data: {
          last_fetch_at: now,
          next_fetch_at: calculateNextFetch(source.schedule_cron),
        }
      });

      results.push({
        sourceId: source.id,
        name: source.name,
        success: result.success,
        error: result.error,
      });

      // Small delay between triggers to avoid overwhelming the worker
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    logger.info(`Cron check complete: ${successCount} triggered, ${failCount} failed`);

    res.json({
      success: true,
      message: `Processed ${dueSources.length} sources`,
      data: {
        triggered: successCount,
        failed: failCount,
        results,
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/sources/cron/status - Get cron status (admin only)
router.get('/cron/status', requireAuth, requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    
    const [dueSources, recentRuns] = await Promise.all([
      prisma.source.count({
        where: {
          is_active: true,
          url: { not: null },
          OR: [
            { next_fetch_at: { lte: now } },
            { next_fetch_at: null },
          ]
        }
      }),
      prisma.ingestRun.findMany({
        where: {
          correlation_id: { startsWith: 'cron-' },
          started_at: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) }
        },
        orderBy: { started_at: 'desc' },
        take: 20,
        include: {
          source: { select: { id: true, name: true } }
        }
      })
    ]);

    res.json({
      success: true,
      data: {
        due_sources: dueSources,
        recent_cron_runs: recentRuns,
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// AI PROCESSING CRON
// ============================================

import { AI_THRESHOLDS } from '../lib/eventCompleteness.js';

/**
 * Helper function to determine status from AI scores
 */
function determineStatusFromAIScores(familyFitScore: number, confidence: number): string {
  if (familyFitScore < AI_THRESHOLDS.FAMILY_FIT_REJECT) {
    return 'rejected';
  }
  if (confidence >= AI_THRESHOLDS.CONFIDENCE_PUBLISH && 
      familyFitScore >= AI_THRESHOLDS.FAMILY_FIT_PUBLISH) {
    return 'published';
  }
  return 'pending_review';
}

// POST /api/sources/cron/process-pending-ai - Process pending_ai events (called by Vercel cron)
router.post('/cron/process-pending-ai', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Verify cron secret
    const authHeader = req.headers.authorization;
    const providedSecret = authHeader?.replace('Bearer ', '');
    
    if (CRON_SECRET && providedSecret !== CRON_SECRET) {
      throw createError('Invalid cron secret', 401, 'UNAUTHORIZED');
    }
    
    const BATCH_SIZE = 20; // Process max 20 per cron run to avoid timeout
    
    // Get events with pending_ai status
    const pendingEvents = await prisma.canonicalEvent.findMany({
      where: { status: 'pending_ai' },
      take: BATCH_SIZE,
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        title: true,
        description_short: true,
        description_long: true,
        location_address: true,
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
        processed: 0 
      });
    }
    
    logger.info(`Cron: Processing ${pendingEvents.length} pending_ai events`);
    
    const results: Array<{ id: string; status?: string; success: boolean; error?: string }> = [];
    
    for (const event of pendingEvents) {
      try {
        // Classification
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
          throw new Error(`Classification failed: ${classifyRes.status}`);
        }
        const classification = await classifyRes.json();
        
        // Scoring
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
          throw new Error(`Scoring failed: ${scoreRes.status}`);
        }
        const scores = await scoreRes.json();
        
        // Determine new status
        const newStatus = determineStatusFromAIScores(
          scores.family_fit_score,
          classification.confidence
        );
        
        // Update event
        await prisma.canonicalEvent.update({
          where: { id: event.id },
          data: {
            status: newStatus,
            age_min: classification.age_min ?? undefined,
            age_max: classification.age_max ?? undefined,
            is_indoor: classification.is_indoor,
            is_outdoor: classification.is_outdoor,
          }
        });
        
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
            ai_model_version: 'cron-v1',
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
        
        // Add categories
        if (classification.categories?.length > 0) {
          const categories = await prisma.category.findMany({
            where: { slug: { in: classification.categories } }
          });
          for (const cat of categories) {
            await prisma.eventCategory.upsert({
              where: { event_id_category_id: { event_id: event.id, category_id: cat.id } },
              create: { event_id: event.id, category_id: cat.id },
              update: {},
            });
          }
        }
        
        results.push({ id: event.id, status: newStatus, success: true });
        
        // Small delay to avoid overwhelming the worker
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (err) {
        results.push({ id: event.id, success: false, error: (err as Error).message });
        logger.error(`Cron: Failed to process event ${event.id}: ${(err as Error).message}`);
      }
    }
    
    const summary = {
      total: results.length,
      published: results.filter(r => r.status === 'published').length,
      pending_review: results.filter(r => r.status === 'pending_review').length,
      rejected: results.filter(r => r.status === 'rejected').length,
      failed: results.filter(r => !r.success).length,
    };
    
    logger.info(`Cron: AI processing complete - ${summary.published} published, ${summary.pending_review} pending_review, ${summary.rejected} rejected, ${summary.failed} failed`);

    res.json({
      success: true,
      message: `Processed ${results.length} events`,
      data: {
        summary,
        results,
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
