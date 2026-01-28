/**
 * AI Usage Monitoring API
 * 
 * Features:
 * - Aggregated statistics for dashboard
 * - Detailed logs (cursor-based pagination)
 * - Cost breakdown by model/operation
 * - Secure log ingestion endpoint for AI worker
 * 
 * Security:
 * - Admin endpoints require admin role
 * - Log ingestion requires service token (HMAC or API key)
 * - No PII stored (prompts/content never logged)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { body, query, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import crypto from 'crypto';

const router = Router();

// ============================================
// MIDDLEWARE
// ============================================

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const authReq = req as AuthRequest;
  if (authReq.user?.role !== 'admin') {
    return next(createError('Admin access required', 403, 'FORBIDDEN'));
  }
  next();
};

/**
 * Verify service token for AI worker
 * Uses HMAC signature or simple API key
 */
const verifyServiceToken = (req: Request, res: Response, next: NextFunction) => {
  const serviceToken = process.env.AI_SERVICE_TOKEN;
  
  if (!serviceToken) {
    // In development without token, allow requests
    if (process.env.NODE_ENV !== 'production') {
      return next();
    }
    return next(createError('Service token not configured', 503, 'SERVICE_ERROR'));
  }

  const providedToken = req.headers['x-service-token'] as string;
  
  if (!providedToken) {
    return next(createError('Service token required', 401, 'UNAUTHORIZED'));
  }

  // Constant-time comparison to prevent timing attacks
  const isValid = crypto.timingSafeEqual(
    Buffer.from(providedToken),
    Buffer.from(serviceToken)
  );

  if (!isValid) {
    return next(createError('Invalid service token', 401, 'UNAUTHORIZED'));
  }

  next();
};

// Simple rate limit for log ingestion (in-memory, per-minute)
const logIngestionLimits = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGS_PER_MINUTE = 100;

const rateLimitLogIngestion = (req: Request, res: Response, next: NextFunction) => {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const limit = logIngestionLimits.get(key);

  if (limit && limit.resetAt > now) {
    if (limit.count >= MAX_LOGS_PER_MINUTE) {
      return next(createError('Rate limit exceeded', 429, 'RATE_LIMITED'));
    }
    limit.count++;
  } else {
    logIngestionLimits.set(key, { count: 1, resetAt: now + 60000 });
  }

  next();
};

// ============================================
// ADMIN ENDPOINTS
// ============================================

/**
 * GET /api/admin/ai-usage/stats
 * Get aggregated statistics for dashboard
 */
router.get('/stats', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { days = 30 } = req.query;
    const daysNum = Math.min(Number(days) || 30, 90);
    
    const since = new Date();
    since.setDate(since.getDate() - daysNum);

    // Total stats
    const [totalStats, byModel, byOperation, dailyCosts] = await Promise.all([
      // Overall totals
      prisma.aIUsageLog.aggregate({
        where: { timestamp: { gte: since } },
        _sum: {
          input_tokens: true,
          output_tokens: true,
          estimated_cost_usd: true,
        },
        _count: { id: true },
        _avg: { response_time_ms: true },
      }),

      // By model
      prisma.aIUsageLog.groupBy({
        by: ['model'],
        where: { timestamp: { gte: since } },
        _sum: {
          input_tokens: true,
          output_tokens: true,
          estimated_cost_usd: true,
        },
        _count: { id: true },
      }),

      // By operation
      prisma.aIUsageLog.groupBy({
        by: ['operation'],
        where: { timestamp: { gte: since } },
        _sum: {
          input_tokens: true,
          output_tokens: true,
          estimated_cost_usd: true,
        },
        _count: { id: true },
      }),

      // Daily costs (for chart)
      prisma.$queryRaw<{ date: string; cost: number; calls: number }[]>`
        SELECT 
          DATE(timestamp AT TIME ZONE 'UTC') as date,
          COALESCE(SUM(estimated_cost_usd), 0)::float as cost,
          COUNT(*)::int as calls
        FROM ai_usage_log
        WHERE timestamp >= ${since}
        GROUP BY DATE(timestamp AT TIME ZONE 'UTC')
        ORDER BY date ASC
      `,
    ]);

    // Error rate
    const errorCount = await prisma.aIUsageLog.count({
      where: {
        timestamp: { gte: since },
        error_code: { not: null },
      },
    });

    // Cache hit rate
    const cacheStats = await prisma.aIUsageLog.groupBy({
      by: ['was_cached'],
      where: { timestamp: { gte: since } },
      _count: { id: true },
    });
    const cachedCount = cacheStats.find(c => c.was_cached)?._count.id || 0;
    const totalCount = totalStats._count.id || 1;

    res.json({
      success: true,
      data: {
        period: { days: daysNum, since: since.toISOString() },
        totals: {
          calls: totalStats._count.id || 0,
          inputTokens: totalStats._sum.input_tokens || 0,
          outputTokens: totalStats._sum.output_tokens || 0,
          costUsd: Number(totalStats._sum.estimated_cost_usd || 0),
          avgResponseMs: Math.round(totalStats._avg.response_time_ms || 0),
          errorRate: totalCount > 0 ? (errorCount / totalCount) : 0,
          cacheHitRate: totalCount > 0 ? (cachedCount / totalCount) : 0,
        },
        byModel: byModel.map(m => ({
          model: m.model,
          calls: m._count.id,
          inputTokens: m._sum.input_tokens || 0,
          outputTokens: m._sum.output_tokens || 0,
          costUsd: Number(m._sum.estimated_cost_usd || 0),
        })),
        byOperation: byOperation.map(o => ({
          operation: o.operation,
          calls: o._count.id,
          inputTokens: o._sum.input_tokens || 0,
          outputTokens: o._sum.output_tokens || 0,
          costUsd: Number(o._sum.estimated_cost_usd || 0),
        })),
        dailyCosts: dailyCosts.map(d => ({
          date: d.date,
          cost: Number(d.cost),
          calls: d.calls,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/ai-usage/logs
 * Get detailed logs with cursor-based pagination
 */
router.get('/logs', requireAuth, requireAdmin, [
  query('cursor').optional().isString(),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('model').optional().isString(),
  query('operation').optional().isString(),
  query('hasError').optional().isBoolean(),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cursor, limit = 50, model, operation, hasError } = req.query;
    const limitNum = Math.min(Number(limit) || 50, 100);

    const where: any = {};
    if (model) where.model = model;
    if (operation) where.operation = operation;
    if (hasError === 'true') where.error_code = { not: null };
    if (hasError === 'false') where.error_code = null;

    const logs = await prisma.aIUsageLog.findMany({
      where,
      take: limitNum + 1, // Extra to check if there's more
      ...(cursor && {
        cursor: { id: cursor as string },
        skip: 1, // Skip the cursor itself
      }),
      orderBy: { timestamp: 'desc' },
      select: {
        id: true,
        timestamp: true,
        model: true,
        operation: true,
        input_tokens: true,
        output_tokens: true,
        estimated_cost_usd: true,
        response_time_ms: true,
        was_cached: true,
        error_code: true,
        event_id: true,
        request_id: true,
      },
    });

    const hasMore = logs.length > limitNum;
    const items = hasMore ? logs.slice(0, -1) : logs;
    const nextCursor = hasMore ? items[items.length - 1]?.id : null;

    res.json({
      success: true,
      data: items,
      meta: {
        nextCursor,
        hasMore,
        limit: limitNum,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/ai-usage/costs
 * Get cost breakdown for budgeting
 */
router.get('/costs', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    
    // Current month
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    
    // Previous month
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const [currentMonth, previousMonth, todayCost] = await Promise.all([
      prisma.aIUsageLog.aggregate({
        where: { timestamp: { gte: monthStart } },
        _sum: { estimated_cost_usd: true },
        _count: { id: true },
      }),
      prisma.aIUsageLog.aggregate({
        where: {
          timestamp: {
            gte: prevMonthStart,
            lte: prevMonthEnd,
          },
        },
        _sum: { estimated_cost_usd: true },
        _count: { id: true },
      }),
      prisma.aIUsageLog.aggregate({
        where: {
          timestamp: {
            gte: new Date(now.toISOString().split('T')[0]),
          },
        },
        _sum: { estimated_cost_usd: true },
        _count: { id: true },
      }),
    ]);

    // Projection for month end
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const currentCost = Number(currentMonth._sum.estimated_cost_usd || 0);
    const projectedMonthCost = dayOfMonth > 0 
      ? (currentCost / dayOfMonth) * daysInMonth 
      : 0;

    // Budget from env (optional)
    const monthlyBudget = process.env.AI_MONTHLY_BUDGET_USD 
      ? parseFloat(process.env.AI_MONTHLY_BUDGET_USD) 
      : null;

    res.json({
      success: true,
      data: {
        today: {
          cost: Number(todayCost._sum.estimated_cost_usd || 0),
          calls: todayCost._count.id || 0,
        },
        currentMonth: {
          cost: currentCost,
          calls: currentMonth._count.id || 0,
          projected: projectedMonthCost,
          daysRemaining: daysInMonth - dayOfMonth,
        },
        previousMonth: {
          cost: Number(previousMonth._sum.estimated_cost_usd || 0),
          calls: previousMonth._count.id || 0,
        },
        budget: monthlyBudget ? {
          limit: monthlyBudget,
          used: currentCost,
          remaining: monthlyBudget - currentCost,
          percentUsed: (currentCost / monthlyBudget) * 100,
        } : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// AI WORKER LOG INGESTION
// ============================================

/**
 * POST /api/ai/log-usage
 * Endpoint for AI worker to report usage
 * 
 * Secured by service token, rate limited
 */
router.post('/log', verifyServiceToken, rateLimitLogIngestion, [
  body('model').isString().isLength({ min: 1, max: 50 }),
  body('operation').isString().isLength({ min: 1, max: 50 }),
  body('input_tokens').optional().isInt({ min: 0 }),
  body('output_tokens').optional().isInt({ min: 0 }),
  body('estimated_cost_usd').optional().isFloat({ min: 0 }),
  body('price_input_per_1k').optional().isFloat({ min: 0 }),
  body('price_output_per_1k').optional().isFloat({ min: 0 }),
  body('pricing_version').optional().isString().isLength({ max: 20 }),
  body('event_id').optional().isUUID(),
  body('user_id').optional().isUUID(),
  body('request_id').optional().isString().isLength({ max: 50 }),
  body('response_time_ms').optional().isInt({ min: 0 }),
  body('was_cached').optional().isBoolean(),
  body('error_code').optional().isString().isLength({ max: 50 }),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError(
        'Validation error: ' + errors.array().map(e => e.msg).join(', '),
        422,
        'VALIDATION_ERROR'
      );
    }

    const {
      model,
      operation,
      input_tokens,
      output_tokens,
      estimated_cost_usd,
      price_input_per_1k,
      price_output_per_1k,
      pricing_version,
      event_id,
      user_id,
      request_id,
      response_time_ms,
      was_cached,
      error_code,
    } = req.body;

    // Calculate cost if not provided but tokens and prices are
    let cost = estimated_cost_usd;
    if (cost === undefined && input_tokens && output_tokens && price_input_per_1k && price_output_per_1k) {
      cost = (input_tokens / 1000 * price_input_per_1k) + (output_tokens / 1000 * price_output_per_1k);
    }

    await prisma.aIUsageLog.create({
      data: {
        model,
        operation,
        input_tokens: input_tokens || null,
        output_tokens: output_tokens || null,
        estimated_cost_usd: cost || null,
        price_input_per_1k: price_input_per_1k || null,
        price_output_per_1k: price_output_per_1k || null,
        pricing_version: pricing_version || null,
        event_id: event_id || null,
        user_id: user_id || null,
        request_id: request_id || null,
        response_time_ms: response_time_ms || null,
        was_cached: was_cached || false,
        error_code: error_code || null,
      },
    });

    res.status(201).json({ success: true });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/ai/log-usage/batch
 * Batch log multiple usage entries
 */
router.post('/log/batch', verifyServiceToken, rateLimitLogIngestion, [
  body('logs').isArray({ min: 1, max: 50 }),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { logs } = req.body;

    const entries = logs.map((log: any) => ({
      model: log.model,
      operation: log.operation,
      input_tokens: log.input_tokens || null,
      output_tokens: log.output_tokens || null,
      estimated_cost_usd: log.estimated_cost_usd || null,
      price_input_per_1k: log.price_input_per_1k || null,
      price_output_per_1k: log.price_output_per_1k || null,
      pricing_version: log.pricing_version || null,
      event_id: log.event_id || null,
      user_id: log.user_id || null,
      request_id: log.request_id || null,
      response_time_ms: log.response_time_ms || null,
      was_cached: log.was_cached || false,
      error_code: log.error_code || null,
    }));

    await prisma.aIUsageLog.createMany({ data: entries });

    res.status(201).json({ success: true, count: entries.length });
  } catch (error) {
    next(error);
  }
});

export default router;
