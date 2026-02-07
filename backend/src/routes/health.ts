import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { checkRedisHealth, isRedisAvailable } from '../lib/redis.js';
import { getQueueStats } from '../lib/jobQueue.js';

const router = Router();

interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
  services: {
    database: { status: string; latencyMs?: number; error?: string };
    redis: { status: string; error?: string };
  };
  queue?: {
    queued: number;
    running: number;
    failed: number;
  };
  metrics?: {
    eventsTotal?: number;
    sourcesActive?: number;
    lastTrendCompute?: string;
  };
}

/**
 * GET /api/health
 * Basic health check - fast, for load balancers
 */
router.get('/', async (_req: Request, res: Response) => {
  const healthcheck: HealthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '0.1.0',
    environment: process.env.NODE_ENV || 'development',
    services: {
      database: { status: 'unknown' },
      redis: { status: 'unknown' },
    },
  };

  // Check database connection
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    healthcheck.services.database = {
      status: 'ok',
      latencyMs: Date.now() - dbStart,
    };
  } catch (error: any) {
    healthcheck.services.database = {
      status: 'error',
      error: error.message,
    };
    healthcheck.status = 'degraded';
  }

  // Check Redis connection
  const redisHealth = checkRedisHealth();
  healthcheck.services.redis = {
    status: redisHealth.status,
    ...(redisHealth.error && { error: redisHealth.error }),
  };

  // Redis error in production = degraded
  if (!redisHealth.ok && process.env.NODE_ENV === 'production') {
    healthcheck.status = 'degraded';
  }

  const statusCode = healthcheck.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(healthcheck);
});

/**
 * GET /api/health/detailed
 * Detailed health check - includes queue stats and metrics
 * Use for monitoring dashboards, not for load balancer checks
 */
router.get('/detailed', async (_req: Request, res: Response) => {
  const healthcheck: HealthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '0.1.0',
    environment: process.env.NODE_ENV || 'development',
    services: {
      database: { status: 'unknown' },
      redis: { status: 'unknown' },
    },
  };

  // Check database connection
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    healthcheck.services.database = {
      status: 'ok',
      latencyMs: Date.now() - dbStart,
    };
  } catch (error: any) {
    healthcheck.services.database = {
      status: 'error',
      error: error.message,
    };
    healthcheck.status = 'degraded';
  }

  // Check Redis connection
  const redisHealth = checkRedisHealth();
  healthcheck.services.redis = {
    status: redisHealth.status,
    ...(redisHealth.error && { error: redisHealth.error }),
  };

  if (!redisHealth.ok && process.env.NODE_ENV === 'production') {
    healthcheck.status = 'degraded';
  }

  // Get queue stats
  try {
    const queueStats = await getQueueStats();
    healthcheck.queue = {
      queued: queueStats.queued,
      running: queueStats.running,
      failed: queueStats.failed,
    };
  } catch (error) {
    // Queue stats are optional
  }

  // Get basic metrics
  try {
    const [eventsCount, sourcesCount, lastTrend] = await Promise.all([
      prisma.canonicalEvent.count({
        where: { status: 'published' },
      }),
      prisma.source.count({
        where: { is_active: true },
      }),
      prisma.trendingTerm.findFirst({
        orderBy: { computedAt: 'desc' },
        select: { computedAt: true },
      }),
    ]);

    healthcheck.metrics = {
      eventsTotal: eventsCount,
      sourcesActive: sourcesCount,
      lastTrendCompute: lastTrend?.computedAt?.toISOString() ?? undefined,
    };
  } catch (error) {
    // Metrics are optional
  }

  const statusCode = healthcheck.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(healthcheck);
});

/**
 * GET /api/health/ready
 * Readiness check - is the service ready to accept traffic?
 */
router.get('/ready', async (_req: Request, res: Response) => {
  try {
    // Must have database connection
    await prisma.$queryRaw`SELECT 1`;

    // In production, Redis should be ready too
    if (process.env.NODE_ENV === 'production' && process.env.REDIS_URL) {
      if (!isRedisAvailable()) {
        return res.status(503).json({
          ready: false,
          reason: 'Redis not connected',
        });
      }
    }

    res.json({ ready: true });
  } catch (error: any) {
    res.status(503).json({
      ready: false,
      reason: error.message,
    });
  }
});

/**
 * GET /api/health/live
 * Liveness check - is the process alive?
 * Should always return 200 unless the process is dead
 */
router.get('/live', (_req: Request, res: Response) => {
  res.json({ alive: true, uptime: process.uptime() });
});

export default router;
