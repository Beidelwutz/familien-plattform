import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { signToken, requireAuth, type AuthRequest } from '../middleware/auth.js';
import { verifyToken as verifySupabaseToken, isSupabaseConfigured } from '../lib/supabase.js';
import { 
  sendPasswordResetEmail, 
  sendWelcomeEmail, 
  sendVerificationEmail,
  sendPasswordChangedEmail,
  sendAccountLockedEmail,
  sendEmailChangedEmail,
  sendAccountDeletedEmail
} from '../lib/email.js';
import { authLimiter } from '../middleware/rateLimit.js';

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
router.post('/register', authLimiter, registerValidation, async (req: Request, res: Response, next: NextFunction) => {
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

// Account lockout constants
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;

// POST /api/auth/login
router.post('/login', authLimiter, loginValidation, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error', 400, 'VALIDATION_ERROR');
    }

    const { email, password } = req.body;

    // Find user with lockout fields
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        password_hash: true,
        role: true,
        created_at: true,
        failed_login_attempts: true,
        locked_until: true
      }
    });

    if (!user || !user.password_hash) {
      throw createError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
    }

    // Check if account is locked
    if (user.locked_until && user.locked_until > new Date()) {
      const remainingMinutes = Math.ceil((user.locked_until.getTime() - Date.now()) / 60000);
      throw createError(
        `Account temporarily locked. Try again in ${remainingMinutes} minute(s).`,
        423,
        'ACCOUNT_LOCKED'
      );
    }

    // Verify password
    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      // Increment failed attempts
      const newAttempts = user.failed_login_attempts + 1;
      const updateData: any = {
        failed_login_attempts: newAttempts
      };

      // Lock account after max attempts
      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
        updateData.locked_until = lockUntil;
      }

      await prisma.user.update({
        where: { id: user.id },
        data: updateData
      });

      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        // Send account locked notification email (non-blocking)
        sendAccountLockedEmail(user.email, LOCKOUT_DURATION_MINUTES).catch(err => {
          console.error('Failed to send account locked email:', err);
        });

        throw createError(
          `Too many failed attempts. Account locked for ${LOCKOUT_DURATION_MINUTES} minutes.`,
          423,
          'ACCOUNT_LOCKED'
        );
      }

      throw createError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
    }

    // Reset failed attempts and update last login on successful login
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failed_login_attempts: 0,
        locked_until: null,
        last_login_at: new Date()
      }
    });

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
// Note: This endpoint only READS the user, it does NOT sync. Use POST /api/auth/sync for that.
router.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    const user = await prisma.user.findUnique({
      where: { id: authReq.user!.sub },
      select: { id: true, email: true, role: true, email_verified: true, created_at: true }
    });
    if (!user) {
      // User exists in Supabase but not in Prisma - they need to call /sync first
      return next(createError('Account not found. Please try logging in again.', 404, 'ACCOUNT_NOT_FOUND'));
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
// SUPABASE USER SYNC
// ============================================

// POST /api/auth/sync - Explicit user sync from Supabase to Prisma
// This endpoint ensures the Prisma user exists before the app considers the user "logged in"
// Handles the case where a user logs in with OAuth (Google) but already has an account with the same email
router.post('/sync', async (req: Request, res: Response, _next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: { code: 'AUTH_INVALID', message: 'Authentication required' } 
    });
  }

  if (!isSupabaseConfigured) {
    return res.status(503).json({ 
      success: false, 
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Supabase is not configured' } 
    });
  }

  try {
    const supabaseUser = await verifySupabaseToken(token);

    if (!supabaseUser) {
      return res.status(401).json({ 
        success: false, 
        error: { code: 'AUTH_INVALID', message: 'Invalid or expired token' } 
      });
    }

    // Check if email exists
    if (!supabaseUser.email) {
      return res.status(409).json({ 
        success: false, 
        error: { code: 'EMAIL_MISSING', message: 'No email associated with this account' } 
      });
    }

    // Database operations with retry for transient connection errors
    const DB_RETRY_CODES = ['P2024', 'P1001', 'P1002'];
    const MAX_DB_RETRIES = 2;
    let user: any = null;
    let lastDbError: any = null;

    for (let attempt = 0; attempt <= MAX_DB_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[Sync] DB retry ${attempt}/${MAX_DB_RETRIES} for user ${supabaseUser.email}`);
          // Exponential backoff: 500ms, 1000ms
          await new Promise(r => setTimeout(r, attempt * 500));
        }

        // First, check if user exists by Supabase ID
        user = await prisma.user.findUnique({
          where: { id: supabaseUser.id },
          select: {
            id: true,
            email: true,
            role: true,
            email_verified: true,
            created_at: true
          }
        });

        if (user) {
          // User exists with this Supabase ID - update email if changed
          if (user.email !== supabaseUser.email) {
            user = await prisma.user.update({
              where: { id: supabaseUser.id },
              data: { 
                email: supabaseUser.email, 
                updated_at: new Date() 
              },
              select: {
                id: true,
                email: true,
                role: true,
                email_verified: true,
                created_at: true
              }
            });
          }
        } else {
          // User doesn't exist with this Supabase ID
          // Check if a user with this email already exists (from email/password registration)
          const existingUserByEmail = await prisma.user.findUnique({
            where: { email: supabaseUser.email },
            select: {
              id: true,
              email: true,
              role: true,
              email_verified: true,
              created_at: true
            }
          });

          if (existingUserByEmail) {
            // User registered with email/password before
            // Return the existing user - the auth middleware will use the Prisma ID
            // This allows users to log in with both email/password AND OAuth
            user = existingUserByEmail;
            
            // Update last activity timestamp
            await prisma.user.update({
              where: { id: existingUserByEmail.id },
              data: { updated_at: new Date() }
            });
          } else {
            // Completely new user - create them with the Supabase ID
            user = await prisma.user.create({
              data: { 
                id: supabaseUser.id, 
                email: supabaseUser.email, 
                role: 'parent' 
              },
              select: {
                id: true,
                email: true,
                role: true,
                email_verified: true,
                created_at: true
              }
            });
          }
        }

        // DB operations succeeded - break out of retry loop
        lastDbError = null;
        break;
      } catch (dbErr: any) {
        lastDbError = dbErr;
        // Only retry on transient connection errors
        if (!DB_RETRY_CODES.includes(dbErr.code) || attempt === MAX_DB_RETRIES) {
          throw dbErr;
        }
        console.warn(`[Sync] Transient DB error (${dbErr.code}), will retry...`);
      }
    }

    if (!user) {
      throw lastDbError || new Error('User sync failed after retries');
    }

    // Upsert FamilyProfile (ensure it exists)
    await prisma.familyProfile.upsert({
      where: { user_id: user.id },
      update: {},
      create: { user_id: user.id }
    });

    return res.json({
      success: true,
      message: 'User synchronized successfully',
      data: user
    });
  } catch (err: any) {
    // Log detailed error for debugging
    console.error('Sync failed:', {
      error: err.message || err,
      code: err.code,
      meta: err.meta,
      stack: err.stack
    });
    
    // Check for specific Prisma errors
    let errorMessage = 'Failed to sync user account';
    let errorCode = 'ACCOUNT_SYNC_FAILED';
    let statusCode = 500;
    
    if (err.code === 'P2002') {
      // Unique constraint violation
      errorMessage = 'Ein Konto mit dieser E-Mail existiert bereits';
      errorCode = 'EMAIL_EXISTS';
      statusCode = 409;
    } else if (err.code === 'P2025') {
      // Record not found
      errorMessage = 'Datensatz nicht gefunden';
      errorCode = 'NOT_FOUND';
      statusCode = 404;
    } else if (err.code === 'P2024') {
      // Database connection timeout
      errorMessage = 'Datenbankverbindung fehlgeschlagen. Bitte versuche es erneut.';
      errorCode = 'DB_CONNECTION_ERROR';
      statusCode = 503;
    } else if (err.code === 'P1001' || err.code === 'P1002') {
      // Database unreachable
      errorMessage = 'Datenbank nicht erreichbar. Bitte versuche es später erneut.';
      errorCode = 'DB_UNAVAILABLE';
      statusCode = 503;
    } else if (err.message?.includes('Supabase not configured')) {
      errorMessage = 'Authentifizierungsdienst nicht konfiguriert';
      errorCode = 'SERVICE_UNAVAILABLE';
      statusCode = 503;
    } else if (err.message?.includes('Invalid UUID')) {
      errorMessage = 'Ungültige Benutzer-ID';
      errorCode = 'INVALID_USER_ID';
      statusCode = 400;
    }
    
    return res.status(statusCode).json({ 
      success: false, 
      error: { code: errorCode, message: errorMessage } 
    });
  }
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

    // Send password changed confirmation email (non-blocking)
    sendPasswordChangedEmail(user.email).catch(err => {
      console.error('Failed to send password changed email:', err);
    });

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
// EMAIL CHANGE (AUTHENTICATED)
// ============================================

// PUT /api/auth/change-email - Request email change (sends verification to new email)
router.put('/change-email', requireAuth, [
  body('newEmail').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Current password is required for verification'),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error: ' + errors.array().map(e => e.msg).join(', '), 400, 'VALIDATION_ERROR');
    }

    const authReq = req as AuthRequest;
    const { newEmail, password } = req.body;

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
      throw createError('Cannot change email for OAuth-only accounts', 400, 'NO_PASSWORD');
    }

    // Verify password
    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      throw createError('Password is incorrect', 401, 'INVALID_PASSWORD');
    }

    // Check if new email is same as current
    if (user.email.toLowerCase() === newEmail.toLowerCase()) {
      throw createError('New email must be different from current email', 400, 'SAME_EMAIL');
    }

    // Check if new email is already taken
    const existingUser = await prisma.user.findUnique({
      where: { email: newEmail }
    });

    if (existingUser) {
      throw createError('Email is already in use', 400, 'EMAIL_EXISTS');
    }

    const oldEmail = user.email;

    // Update email directly (in a full implementation, you'd send a verification email first)
    // For now, we update immediately but mark as unverified
    await prisma.user.update({
      where: { id: user.id },
      data: {
        email: newEmail,
        email_verified: false,
        email_verified_at: null,
        updated_at: new Date()
      }
    });

    // Generate new token with updated email
    const newToken = signToken({ sub: user.id, email: newEmail, role: user.role });

    // Send notification to OLD email address about the change (non-blocking)
    sendEmailChangedEmail(oldEmail, newEmail).catch(err => {
      console.error('Failed to send email changed notification:', err);
    });

    // Send verification email to new address
    const verificationToken = signToken({
      sub: user.id,
      email: newEmail,
      role: 'email_verification'
    });
    sendVerificationEmail(newEmail, verificationToken).catch(err => {
      console.error('Failed to send verification email:', err);
    });

    res.json({
      success: true,
      message: 'Email changed successfully. Please verify your new email address.',
      data: {
        token: newToken,
        email: newEmail
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// ACCOUNT DELETION (AUTHENTICATED)
// ============================================

// DELETE /api/auth/account - Delete user account
router.delete('/account', requireAuth, [
  body('password').notEmpty().withMessage('Password is required for account deletion'),
  body('confirmation').equals('DELETE').withMessage('Please type DELETE to confirm'),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error: ' + errors.array().map(e => e.msg).join(', '), 400, 'VALIDATION_ERROR');
    }

    const authReq = req as AuthRequest;
    const { password } = req.body;

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
      throw createError('Cannot delete OAuth-only accounts through this endpoint', 400, 'NO_PASSWORD');
    }

    // Verify password
    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      throw createError('Password is incorrect', 401, 'INVALID_PASSWORD');
    }

    // Prevent admin self-deletion if they're the only admin
    if (user.role === 'admin') {
      const adminCount = await prisma.user.count({
        where: { role: 'admin' }
      });
      if (adminCount <= 1) {
        throw createError('Cannot delete the last admin account', 400, 'LAST_ADMIN');
      }
    }

    const userEmail = user.email;

    // Delete user and all related data (cascading deletes handle most relations)
    // Note: This permanently deletes the user account and associated data
    await prisma.$transaction(async (tx) => {
      // Delete provider profile if exists (events will remain but be orphaned)
      await tx.provider.deleteMany({
        where: { user_id: user.id }
      });

      // Delete the user (cascading deletes will handle: 
      // - FamilyProfile, SavedEvents, Plans, PasswordResetTokens)
      await tx.user.delete({
        where: { id: user.id }
      });
    });

    // Send account deleted confirmation email (non-blocking)
    sendAccountDeletedEmail(userEmail).catch(err => {
      console.error('Failed to send account deleted email:', err);
    });

    res.json({
      success: true,
      message: 'Account deleted successfully'
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// PASSWORD RESET FLOW
// ============================================

// Password reset token expiry (1 hour)
const PASSWORD_RESET_EXPIRY_HOURS = 1;

// Helper to generate secure token and hash
function generateSecureToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

// POST /api/auth/forgot-password - Request password reset
router.post('/forgot-password', authLimiter, [
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
      // Invalidate any existing unused reset tokens for this user
      await prisma.passwordResetToken.updateMany({
        where: {
          user_id: user.id,
          used_at: null
        },
        data: {
          used_at: new Date() // Mark as used/invalidated
        }
      });

      // Generate new secure token
      const { token, hash } = generateSecureToken();
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_HOURS * 60 * 60 * 1000);

      // Store token hash in database
      await prisma.passwordResetToken.create({
        data: {
          user_id: user.id,
          token_hash: hash,
          expires_at: expiresAt
        }
      });

      // Send password reset email with the plain token
      const emailSent = await sendPasswordResetEmail(user.email, token);
      
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
router.post('/reset-password', authLimiter, [
  body('token').notEmpty(),
  body('password').isLength({ min: 8 }),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Invalid input', 400, 'VALIDATION_ERROR');
    }

    const { token, password } = req.body;

    // Hash the provided token to compare with stored hash
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find valid token in database
    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        token_hash: tokenHash,
        used_at: null,
        expires_at: { gt: new Date() }
      },
      include: {
        user: {
          select: { id: true, email: true }
        }
      }
    });

    if (!resetToken) {
      throw createError('Invalid or expired reset token', 400, 'INVALID_TOKEN');
    }

    // Update password and mark token as used
    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetToken.user_id },
        data: { 
          password_hash: await hashPassword(password),
          // Also reset any lockout when password is successfully reset
          failed_login_attempts: 0,
          locked_until: null
        }
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { used_at: new Date() }
      })
    ]);

    // Send password changed confirmation email (non-blocking)
    sendPasswordChangedEmail(resetToken.user.email).catch(err => {
      console.error('Failed to send password changed email:', err);
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
