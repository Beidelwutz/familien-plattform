import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createError } from './errorHandler.js';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

// In production, JWT_SECRET must be set. In development, use a fallback.
const secret = process.env.JWT_SECRET || (
  process.env.NODE_ENV === 'production' 
    ? (() => { throw new Error('JWT_SECRET must be set in production'); })()
    : 'dev-secret-do-not-use-in-production'
);

export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const exp = process.env.JWT_EXPIRES_IN ?? '7d';
  const expiresInSeconds = typeof exp === 'string' && exp.endsWith('d')
    ? parseInt(exp, 10) * 86400
    : 604800;
  return jwt.sign(payload as object, secret, { expiresIn: expiresInSeconds });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}

/** Optional auth: sets req.user when valid Bearer token present, does not 401 */
export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    const payload = verifyToken(token);
    if (payload) req.user = payload;
  }
  next();
}

/** Require auth: 401 when no valid token */
export function requireAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    next(createError('Authentication required', 401, 'UNAUTHORIZED'));
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    next(createError('Invalid or expired token', 401, 'UNAUTHORIZED'));
    return;
  }
  req.user = payload;
  next();
}

/** Require admin role (use after requireAuth) */
export function requireAdmin(req: AuthRequest, _res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    next(createError('Admin access required', 403, 'FORBIDDEN'));
    return;
  }
  next();
}
