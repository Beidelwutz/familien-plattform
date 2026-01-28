import { Request, Response, NextFunction } from 'express';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  keyGenerator?: (req: Request) => string;
}

interface RateLimitStore {
  [key: string]: {
    count: number;
    resetTime: number;
  };
}

/**
 * Simple in-memory rate limiter
 * For production, consider using redis-based rate limiting
 */
export function createRateLimiter(options: RateLimitOptions) {
  const store: RateLimitStore = {};
  const { windowMs, max, message = 'Too many requests', keyGenerator } = options;

  // Cleanup old entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const key in store) {
      if (store[key].resetTime < now) {
        delete store[key];
      }
    }
  }, windowMs);

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyGenerator ? keyGenerator(req) : req.ip || 'unknown';
    const now = Date.now();

    if (!store[key] || store[key].resetTime < now) {
      store[key] = {
        count: 1,
        resetTime: now + windowMs,
      };
    } else {
      store[key].count++;
    }

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - store[key].count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(store[key].resetTime / 1000));

    if (store[key].count > max) {
      res.status(429).json({
        success: false,
        error: message,
        retry_after_ms: store[key].resetTime - now,
      });
      return;
    }

    next();
  };
}

// Pre-configured rate limiters
export const apiLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests, please try again later',
});

export const ingestLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute for AI-Worker
  message: 'Ingest rate limit exceeded',
  keyGenerator: (req) => req.headers['x-api-key'] as string || req.ip || 'unknown',
});

export const geocodeLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Respect Nominatim limits
  message: 'Geocoding rate limit exceeded',
});

export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 login attempts
  message: 'Too many login attempts, please try again later',
});
