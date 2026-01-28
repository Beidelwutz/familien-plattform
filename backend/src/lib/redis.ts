/**
 * Redis Client Setup
 * 
 * - In production: REDIS_URL is required, fails fast if not set
 * - In development: Falls back to null (features gracefully degrade)
 */

import Redis from 'ioredis';

const isProduction = process.env.NODE_ENV === 'production';
const redisUrl = process.env.REDIS_URL;

// Enforce Redis in production
if (isProduction && !redisUrl) {
  console.error('❌ REDIS_URL is required in production environment');
  console.error('   Queue features will return 503 Service Unavailable');
}

// Create Redis client (null if not configured)
export const redis: Redis | null = redisUrl 
  ? new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      lazyConnect: true,
    })
  : null;

// Connection state
let isConnected = false;
let connectionError: Error | null = null;

if (redis) {
  redis.on('connect', () => {
    isConnected = true;
    connectionError = null;
    console.log('✅ Redis connected');
  });

  redis.on('error', (err) => {
    isConnected = false;
    connectionError = err;
    console.error('❌ Redis error:', err.message);
  });

  redis.on('close', () => {
    isConnected = false;
    console.log('⚠️ Redis connection closed');
  });

  // Connect immediately
  redis.connect().catch((err) => {
    connectionError = err;
    console.error('❌ Redis initial connection failed:', err.message);
  });
}

/**
 * Check if Redis is available and connected
 */
export function isRedisAvailable(): boolean {
  return redis !== null && isConnected;
}

/**
 * Check if Redis is required (production) but not available
 * Returns error message if there's a problem, null if OK
 */
export function checkRedisHealth(): { ok: boolean; status: string; error?: string } {
  if (!redis) {
    if (isProduction) {
      return { ok: false, status: 'not_configured', error: 'REDIS_URL not set in production' };
    }
    return { ok: true, status: 'disabled' };
  }

  if (!isConnected) {
    return { 
      ok: false, 
      status: 'disconnected', 
      error: connectionError?.message || 'Not connected' 
    };
  }

  return { ok: true, status: 'connected' };
}

/**
 * Require Redis for an operation
 * Throws 503 if not available in production
 */
export function requireRedis(): Redis {
  if (!redis || !isConnected) {
    const error = new Error('Redis is not available') as any;
    error.statusCode = 503;
    error.code = 'REDIS_UNAVAILABLE';
    throw error;
  }
  return redis;
}

/**
 * Graceful shutdown
 */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    console.log('Redis connection closed');
  }
}

// Handle process termination
process.on('SIGTERM', closeRedis);
process.on('SIGINT', closeRedis);
