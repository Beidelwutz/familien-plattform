import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { signToken, requireAuth, type AuthRequest } from '../middleware/auth.js';

const router = Router();

const SALT_ROUNDS = 10;

// Secure password hashing with bcrypt
async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Validation
const registerValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
];

const loginValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
];

// POST /api/auth/register
router.post('/register', registerValidation, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error', 400, 'VALIDATION_ERROR');
    }

    const { email, password } = req.body;

    // Check if user exists
    const existing = await prisma.user.findUnique({
      where: { email }
    });

    if (existing) {
      throw createError('Email already registered', 400, 'EMAIL_EXISTS');
    }

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        password_hash: await hashPassword(password),
        role: 'parent'
      },
      select: {
        id: true,
        email: true,
        role: true,
        created_at: true
      }
    });

    // Create empty family profile
    await prisma.familyProfile.create({
      data: {
        user_id: user.id
      }
    });

    const token = signToken({ sub: user.id, email: user.email, role: user.role });

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        user,
        token
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/login
router.post('/login', loginValidation, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error', 400, 'VALIDATION_ERROR');
    }

    const { email, password } = req.body;

    // Find user
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        password_hash: true,
        role: true,
        created_at: true
      }
    });

    if (!user || !user.password_hash) {
      throw createError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
    }

    // Verify password
    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      throw createError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
    }

    const token = signToken({ sub: user.id, email: user.email, role: user.role });

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          created_at: user.created_at
        },
        token
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/me - Get current user (requires valid JWT)
router.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    const user = await prisma.user.findUnique({
      where: { id: authReq.user!.sub },
      select: { id: true, email: true, role: true, created_at: true }
    });
    if (!user) {
      return next(createError('User not found', 404, 'NOT_FOUND'));
    }
    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/logout - client discards token; server has no session/blacklist in this setup
router.post('/logout', (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Logged out'
  });
});

// ============================================
// PASSWORD RESET FLOW
// ============================================

// POST /api/auth/forgot-password - Request password reset
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Invalid email address', 400, 'VALIDATION_ERROR');
    }

    const { email } = req.body;

    // Find user (don't reveal if user exists for security)
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true }
    });

    if (user) {
      // Generate reset token (simple implementation using JWT)
      // In production, use a dedicated token with shorter expiry stored in DB
      const resetToken = signToken({ 
        sub: user.id, 
        email: user.email, 
        role: 'password_reset' 
      });

      // TODO: Send email with reset link
      // For now, log the token (development only)
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[DEV] Password reset token for ${email}:`, resetToken);
        console.log(`[DEV] Reset link: ${process.env.FRONTEND_URL || 'http://localhost:3000'}/passwort-reset?token=${resetToken}`);
      }

      // In production, you would:
      // 1. Store token hash in DB with expiry
      // 2. Send email via service like SendGrid, Resend, etc.
      // await sendPasswordResetEmail(user.email, resetToken);
    }

    // Always return success (don't reveal if email exists)
    res.json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.'
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/reset-password - Reset password with token
router.post('/reset-password', [
  body('token').notEmpty(),
  body('password').isLength({ min: 8 }),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Invalid input', 400, 'VALIDATION_ERROR');
    }

    const { token, password } = req.body;

    // Verify token
    // In production, verify against DB-stored token hash
    const { verifyToken } = await import('../middleware/auth.js');
    const payload = verifyToken(token);
    
    if (!payload || payload.role !== 'password_reset') {
      throw createError('Invalid or expired reset token', 400, 'INVALID_TOKEN');
    }

    // Update password
    await prisma.user.update({
      where: { id: payload.sub },
      data: { password_hash: await hashPassword(password) }
    });

    res.json({
      success: true,
      message: 'Password has been reset successfully. You can now log in with your new password.'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
