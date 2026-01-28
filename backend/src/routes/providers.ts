import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { requireAuth, optionalAuth, type AuthRequest } from '../middleware/auth.js';

const router = Router();

// ============================================
// PUBLIC ENDPOINTS
// ============================================

// GET /api/providers - List public providers
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, limit = 20, offset = 0 } = req.query;

    const where: any = {
      is_verified: true,
    };

    if (type) {
      where.type = type;
    }

    const [providers, total] = await Promise.all([
      prisma.provider.findMany({
        where,
        select: {
          id: true,
          name: true,
          type: true,
          description: true,
          logo_url: true,
          website: true,
          _count: {
            select: { events: true }
          }
        },
        take: Number(limit),
        skip: Number(offset),
        orderBy: { name: 'asc' }
      }),
      prisma.provider.count({ where })
    ]);

    res.json({
      success: true,
      data: providers,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/providers/:id - Get single provider (public)
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const provider = await prisma.provider.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        type: true,
        description: true,
        logo_url: true,
        website: true,
        phone: true,
        email: true,
        address: true,
        is_verified: true,
        events: {
          where: {
            status: 'published',
            start_datetime: { gte: new Date() }
          },
          select: {
            id: true,
            title: true,
            start_datetime: true,
            location_address: true,
          },
          orderBy: { start_datetime: 'asc' },
          take: 10
        },
        _count: {
          select: { events: true }
        }
      }
    });

    if (!provider) {
      throw createError('Provider not found', 404, 'NOT_FOUND');
    }

    res.json({
      success: true,
      data: provider
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// AUTHENTICATED ENDPOINTS
// ============================================

// GET /api/providers/me - Get current user's provider profile
router.get('/me', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;

    const provider = await prisma.provider.findUnique({
      where: { user_id: userId },
      include: {
        _count: {
          select: { events: true }
        }
      }
    });

    if (!provider) {
      // No provider profile yet - this is ok
      return res.json({
        success: true,
        data: null,
        message: 'No provider profile found. Create one to list events.'
      });
    }

    res.json({
      success: true,
      data: provider
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/providers - Create provider profile
router.post('/', requireAuth, [
  body('name').isString().isLength({ min: 2, max: 200 }).withMessage('Name required (2-200 chars)'),
  body('type').isIn(['verein', 'unternehmen', 'kommune', 'kita', 'freiberuflich', 'sonstiges']).withMessage('Invalid type'),
  body('description').optional().isString().isLength({ max: 2000 }),
  body('website').optional().isURL(),
  body('phone').optional().isString().isLength({ max: 50 }),
  body('email').optional().isEmail(),
  body('address').optional().isString().isLength({ max: 300 }),
], async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error: ' + errors.array().map(e => e.msg).join(', '), 400, 'VALIDATION_ERROR');
    }

    const userId = req.user!.sub;

    // Check if user already has a provider profile
    const existing = await prisma.provider.findUnique({
      where: { user_id: userId }
    });

    if (existing) {
      throw createError('Provider profile already exists', 400, 'PROVIDER_EXISTS');
    }

    const {
      name,
      type,
      description,
      website,
      phone,
      email,
      address,
    } = req.body;

    const provider = await prisma.provider.create({
      data: {
        user_id: userId,
        name,
        type,
        description: description || null,
        website: website || null,
        phone: phone || null,
        email: email || req.user!.email,
        address: address || null,
        is_verified: false, // Requires admin verification
      }
    });

    // Update user role to provider
    await prisma.user.update({
      where: { id: userId },
      data: { role: 'provider' }
    });

    res.status(201).json({
      success: true,
      message: 'Provider profile created. Awaiting verification.',
      data: provider
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/providers/me - Update own provider profile
router.put('/me', requireAuth, [
  body('name').optional().isString().isLength({ min: 2, max: 200 }),
  body('description').optional().isString().isLength({ max: 2000 }),
  body('website').optional().isURL(),
  body('phone').optional().isString().isLength({ max: 50 }),
  body('email').optional().isEmail(),
  body('address').optional().isString().isLength({ max: 300 }),
  body('logo_url').optional().isURL(),
], async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error: ' + errors.array().map(e => e.msg).join(', '), 400, 'VALIDATION_ERROR');
    }

    const userId = req.user!.sub;

    const provider = await prisma.provider.findUnique({
      where: { user_id: userId }
    });

    if (!provider) {
      throw createError('Provider profile not found', 404, 'NOT_FOUND');
    }

    const allowedFields = ['name', 'description', 'website', 'phone', 'email', 'address', 'logo_url'];
    const updateData: Record<string, any> = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field] || null;
      }
    }

    if (Object.keys(updateData).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    const updated = await prisma.provider.update({
      where: { user_id: userId },
      data: updateData
    });

    res.json({
      success: true,
      message: 'Provider profile updated',
      data: updated
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/providers/me/events - Get provider's events
router.get('/me/events', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const { status, limit = 20, offset = 0 } = req.query;

    const provider = await prisma.provider.findUnique({
      where: { user_id: userId }
    });

    if (!provider) {
      throw createError('Provider profile not found', 404, 'NOT_FOUND');
    }

    const where: any = {
      provider_id: provider.id
    };

    if (status) {
      where.status = status;
    }

    const [events, total] = await Promise.all([
      prisma.canonicalEvent.findMany({
        where,
        take: Number(limit),
        skip: Number(offset),
        orderBy: { start_datetime: 'desc' },
        include: {
          categories: {
            include: { category: true }
          },
          scores: true
        }
      }),
      prisma.canonicalEvent.count({ where })
    ]);

    res.json({
      success: true,
      data: events,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset)
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// These would require admin middleware - simplified for now

// GET /api/providers/admin/pending - List unverified providers
router.get('/admin/pending', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // Check admin role
    if (req.user!.role !== 'admin') {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }

    const providers = await prisma.provider.findMany({
      where: { is_verified: false },
      include: {
        user: {
          select: { email: true, created_at: true }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    res.json({
      success: true,
      data: providers
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/providers/:id/verify - Verify a provider (admin)
router.post('/:id/verify', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'admin') {
      throw createError('Admin access required', 403, 'FORBIDDEN');
    }

    const { id } = req.params;

    const provider = await prisma.provider.update({
      where: { id },
      data: { is_verified: true }
    });

    res.json({
      success: true,
      message: 'Provider verified',
      data: provider
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/providers/:id - Delete provider (admin or owner)
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const userId = req.user!.sub;
    const isAdmin = req.user!.role === 'admin';

    const provider = await prisma.provider.findUnique({
      where: { id }
    });

    if (!provider) {
      throw createError('Provider not found', 404, 'NOT_FOUND');
    }

    // Only admin or owner can delete
    if (!isAdmin && provider.user_id !== userId) {
      throw createError('Not authorized to delete this provider', 403, 'FORBIDDEN');
    }

    // Soft delete by removing user association (events remain)
    await prisma.provider.update({
      where: { id },
      data: { user_id: null as any } // Disconnect from user
    });

    res.json({
      success: true,
      message: 'Provider profile deleted'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
