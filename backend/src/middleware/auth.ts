import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createError } from './errorHandler.js';
import { verifyToken as verifySupabaseToken } from '../lib/supabase.js';
import { prisma } from '../lib/prisma.js';
import type { UserRole } from '../lib/types.js';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole | 'password_reset' | 'email_verification';
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
 * IMPORTANT: This function no longer syncs users automatically.
 * Use POST /api/auth/sync for explicit user synchronization after login.
 * 
 * For Supabase users, we look up the Prisma user by ID first, then by email.
 * This handles the case where a user registered with email/password first,
 * then logs in with OAuth (Google) - the Supabase ID will be different from
 * the Prisma user ID, but the email will match.
 */
async function verifyToken(token: string): Promise<JwtPayload | null> {
  // Try Supabase token first if configured
  if (isSupabaseConfigured) {
    try {
      const supabaseUser = await verifySupabaseToken(token);
      if (supabaseUser) {
        // Look up user in Prisma (READ ONLY - no sync)
        // First try by Supabase ID, then by email
        let prismaUser = await prisma.user.findUnique({
          where: { id: supabaseUser.id },
          select: { id: true, role: true }
        });
        
        // If not found by ID, try by email (handles OAuth login with existing email account)
        if (!prismaUser && supabaseUser.email) {
          prismaUser = await prisma.user.findUnique({
            where: { email: supabaseUser.email },
            select: { id: true, role: true }
          });
        }
        
        // Use the Prisma user ID if found, otherwise use the Supabase ID
        // This ensures consistency when the user was created with email/password first
        const userId = prismaUser?.id || supabaseUser.id;
        
        return {
          sub: userId,
          email: supabaseUser.email || '',
          // Use Prisma role if user exists, otherwise fall back to metadata or default
          role: prismaUser?.role || supabaseUser.user_metadata?.role || 'parent',
        };
      }
    } catch {
      // Supabase verification failed, try legacy
    }
  }

  // Fall back to legacy JWT
  return verifyLegacyToken(token);
}

/**
 * Sync Supabase user to Prisma User table
 * THROWS on error - no silent failures allowed
 * Used by POST /api/auth/sync endpoint
 */
export async function syncUserToPrisma(supabaseUserId: string, email: string) {
  if (!email) {
    throw new Error('EMAIL_MISSING: Cannot sync user without email');
  }
  
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
    next(createError('Authentication required', 401, 'AUTH_INVALID'));
    return;
  }
  
  const payload = await verifyToken(token);
  
  if (!payload) {
    next(createError('Invalid or expired token', 401, 'AUTH_INVALID'));
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
export async function requireServiceToken(req: Request, _res: Response, next: NextFunction): Promise<void> {
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
  const payload = await verifyToken(token || '');
  if (payload && payload.role === 'admin') {
    next();
  } else {
    next(createError('Service authentication required', 401, 'UNAUTHORIZED'));
  }
}
