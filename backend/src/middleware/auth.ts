import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createError } from './errorHandler.js';
import { verifyToken as verifySupabaseToken } from '../lib/supabase.js';
import { prisma } from '../lib/prisma.js';

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

// Legacy JWT secret for backward compatibility
const secret = process.env.JWT_SECRET || (
  process.env.NODE_ENV === 'production' 
    ? (() => { throw new Error('JWT_SECRET must be set in production'); })()
    : 'dev-secret-do-not-use-in-production'
);

// Check if Supabase is configured
const isSupabaseConfigured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Sign a legacy JWT token (for backward compatibility)
 */
export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const exp = process.env.JWT_EXPIRES_IN ?? '7d';
  const expiresInSeconds = typeof exp === 'string' && exp.endsWith('d')
    ? parseInt(exp, 10) * 86400
    : 604800;
  return jwt.sign(payload as object, secret, { expiresIn: expiresInSeconds });
}

/**
 * Verify a legacy JWT token
 */
export function verifyLegacyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Verify token - tries Supabase first, falls back to legacy JWT
 */
async function verifyToken(token: string): Promise<JwtPayload | null> {
  // Try Supabase token first if configured
  if (isSupabaseConfigured) {
    try {
      const supabaseUser = await verifySupabaseToken(token);
      if (supabaseUser) {
        // Sync user to Prisma if needed and get role
        const prismaUser = await syncUserToPrisma(supabaseUser.id, supabaseUser.email || '');
        
        return {
          sub: supabaseUser.id,
          email: supabaseUser.email || '',
          role: prismaUser?.role || supabaseUser.user_metadata?.role || 'parent',
        };
      }
    } catch (err) {
      // Supabase verification failed, try legacy
      console.debug('Supabase token verification failed, trying legacy JWT');
    }
  }

  // Fall back to legacy JWT
  return verifyLegacyToken(token);
}

/**
 * Sync Supabase user to Prisma User table
 */
async function syncUserToPrisma(supabaseUserId: string, email: string) {
  try {
    const user = await prisma.user.upsert({
      where: { id: supabaseUserId },
      update: { 
        email,
        updated_at: new Date(),
      },
      create: {
        id: supabaseUserId,
        email,
        role: 'parent',
      },
    });
    return user;
  } catch (err) {
    console.error('Failed to sync user to Prisma:', err);
    return null;
  }
}

/** 
 * Optional auth: sets req.user when valid Bearer token present, does not 401 
 */
export async function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  
  if (token) {
    const payload = await verifyToken(token);
    if (payload) {
      req.user = payload;
    }
  }
  
  next();
}

/** 
 * Require auth: 401 when no valid token 
 */
export async function requireAuth(req: AuthRequest, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  
  if (!token) {
    next(createError('Authentication required', 401, 'UNAUTHORIZED'));
    return;
  }
  
  const payload = await verifyToken(token);
  
  if (!payload) {
    next(createError('Invalid or expired token', 401, 'UNAUTHORIZED'));
    return;
  }
  
  req.user = payload;
  next();
}

/** 
 * Require admin role (use after requireAuth) 
 */
export function requireAdmin(req: AuthRequest, _res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    next(createError('Admin access required', 403, 'FORBIDDEN'));
    return;
  }
  next();
}

/**
 * Require service token (for internal service-to-service calls)
 */
export function requireServiceToken(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const serviceToken = process.env.SERVICE_TOKEN;
  
  // If service token is not configured, allow Supabase tokens
  if (!serviceToken) {
    next();
    return;
  }
  
  if (token === serviceToken) {
    next();
    return;
  }
  
  // Also allow valid auth tokens (from admin users)
  verifyToken(token || '').then(payload => {
    if (payload && payload.role === 'admin') {
      next();
    } else {
      next(createError('Service authentication required', 401, 'UNAUTHORIZED'));
    }
  });
}
