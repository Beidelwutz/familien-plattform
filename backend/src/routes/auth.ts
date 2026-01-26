import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import crypto from 'crypto';

const router = Router();

// Simple password hashing (in production, use bcrypt)
function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
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
        password_hash: hashPassword(password),
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

    // TODO: Generate JWT token
    const token = 'mock-jwt-token';

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
    if (!verifyPassword(password, user.password_hash)) {
      throw createError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
    }

    // TODO: Generate JWT token
    const token = 'mock-jwt-token';

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

// GET /api/auth/me - Get current user
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // TODO: Get user from JWT middleware
    // For now, return mock data
    res.json({
      success: true,
      data: null,
      message: 'Not authenticated'
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/logout
router.post('/logout', (_req: Request, res: Response) => {
  // TODO: Invalidate token
  res.json({
    success: true,
    message: 'Logged out'
  });
});

export default router;
