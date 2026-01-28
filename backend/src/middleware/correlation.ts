import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

/**
 * Middleware that generates or extracts a correlation ID for request tracing
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Check for existing correlation ID in headers
  const existingId = req.headers['x-correlation-id'] as string 
    || req.headers['x-request-id'] as string;
  
  // Generate new ID if not provided
  const correlationId = existingId || crypto.randomUUID().substring(0, 8);
  
  // Attach to request
  req.correlationId = correlationId;
  
  // Add to response headers
  res.setHeader('X-Correlation-ID', correlationId);
  
  next();
}
