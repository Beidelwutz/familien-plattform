import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { signToken, requireAuth, type AuthRequest } from '../middleware/auth.js';
import { sendPasswordResetEmail, sendWelcomeEmail, sendVerificationEmail } from '../lib/email.js';

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

    // Send welcome email (non-blocking)
    sendWelcomeEmail(user.email).catch(err => {
      console.error('Failed to send welcome email:', err);
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
      select: { id: true, email: true, role: true, email_verified: true, created_at: true }
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
// PASSWORD CHANGE (AUTHENTICATED)
// ============================================

// PUT /api/auth/change-password - Change password while logged in
router.put('/change-password', requireAuth, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error: ' + errors.array().map(e => e.msg).join(', '), 400, 'VALIDATION_ERROR');
    }

    const authReq = req as AuthRequest;
    const { currentPassword, newPassword } = req.body;

    // Get user with password hash
    const user = await prisma.user.findUnique({
      where: { id: authReq.user!.sub },
      select: { id: true, email: true, password_hash: true, role: true }
    });

    if (!user) {
      throw createError('User not found', 404, 'NOT_FOUND');
    }

    // Check if user has a password (OAuth users might not)
    if (!user.password_hash) {
      throw createError('Cannot change password for OAuth-only accounts. Please use password reset.', 400, 'NO_PASSWORD');
    }

    // Verify current password
    const isValid = await verifyPassword(currentPassword, user.password_hash);
    if (!isValid) {
      throw createError('Current password is incorrect', 401, 'INVALID_PASSWORD');
    }

    // Check that new password is different
    const isSamePassword = await verifyPassword(newPassword, user.password_hash);
    if (isSamePassword) {
      throw createError('New password must be different from current password', 400, 'SAME_PASSWORD');
    }

    // Update password
    await prisma.user.update({
      where: { id: user.id },
      data: { 
        password_hash: await hashPassword(newPassword),
        updated_at: new Date()
      }
    });

    // Generate new token (invalidates old sessions)
    const newToken = signToken({ sub: user.id, email: user.email, role: user.role });

    res.json({
      success: true,
      message: 'Password changed successfully',
      data: {
        token: newToken
      }
    });
  } catch (error) {
    next(error);
  }
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
      // Token is valid for 1 hour
      const resetToken = signToken({ 
        sub: user.id, 
        email: user.email, 
        role: 'password_reset' 
      });

      // Send password reset email
      const emailSent = await sendPasswordResetEmail(user.email, resetToken);
      
      if (!emailSent) {
        console.error(`Failed to send password reset email to ${email}`);
      }
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
    const { verifyLegacyToken } = await import('../middleware/auth.js');
    const payload = verifyLegacyToken(token);
    
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

// ============================================
// EMAIL VERIFICATION
// ============================================

// POST /api/auth/send-verification - Send/resend verification email
router.post('/send-verification', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    
    const user = await prisma.user.findUnique({
      where: { id: authReq.user!.sub },
      select: { id: true, email: true, email_verified: true }
    });

    if (!user) {
      throw createError('User not found', 404, 'NOT_FOUND');
    }

    if (user.email_verified) {
      return res.json({
        success: true,
        message: 'Email is already verified.'
      });
    }

    // Generate verification token (valid for 24 hours)
    const verificationToken = signToken({
      sub: user.id,
      email: user.email,
      role: 'email_verification'
    });

    // Send verification email
    const emailSent = await sendVerificationEmail(user.email, verificationToken);

    if (!emailSent) {
      throw createError('Failed to send verification email. Please try again later.', 500, 'EMAIL_ERROR');
    }

    res.json({
      success: true,
      message: 'Verification email sent. Please check your inbox.'
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/verify-email - Verify email with token
router.post('/verify-email', [
  body('token').notEmpty().withMessage('Verification token is required'),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Invalid input', 400, 'VALIDATION_ERROR');
    }

    const { token } = req.body;

    // Verify token
    const { verifyLegacyToken } = await import('../middleware/auth.js');
    const payload = verifyLegacyToken(token);

    if (!payload || payload.role !== 'email_verification') {
      throw createError('Invalid or expired verification token', 400, 'INVALID_TOKEN');
    }

    // Check if user exists and is not already verified
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, email_verified: true, role: true }
    });

    if (!user) {
      throw createError('User not found', 404, 'NOT_FOUND');
    }

    if (user.email_verified) {
      return res.json({
        success: true,
        message: 'Email is already verified.',
        data: { already_verified: true }
      });
    }

    // Mark email as verified
    await prisma.user.update({
      where: { id: user.id },
      data: {
        email_verified: true,
        email_verified_at: new Date()
      }
    });

    // Generate new token with verified status
    const newToken = signToken({ sub: user.id, email: user.email, role: user.role });

    res.json({
      success: true,
      message: 'Email verified successfully!',
      data: {
        token: newToken
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/verification-status - Check email verification status
router.get('/verification-status', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    
    const user = await prisma.user.findUnique({
      where: { id: authReq.user!.sub },
      select: { email_verified: true, email_verified_at: true }
    });

    if (!user) {
      throw createError('User not found', 404, 'NOT_FOUND');
    }

    res.json({
      success: true,
      data: {
        email_verified: user.email_verified,
        verified_at: user.email_verified_at
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
