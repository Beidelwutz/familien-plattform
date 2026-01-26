import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';

const router = Router();

// TODO: Add auth middleware

// GET /api/user/profile - Get user profile
router.get('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // TODO: Get user ID from auth middleware
    const userId = req.headers['x-user-id'] as string;
    
    if (!userId) {
      throw createError('Not authenticated', 401, 'UNAUTHORIZED');
    }

    const profile = await prisma.familyProfile.findUnique({
      where: { user_id: userId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true
          }
        }
      }
    });

    if (!profile) {
      throw createError('Profile not found', 404, 'NOT_FOUND');
    }

    res.json({
      success: true,
      data: profile
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/user/profile - Update profile
router.put('/profile', [
  body('children_ages').optional().isArray(),
  body('preferred_radius_km').optional().isInt({ min: 1, max: 100 }),
  body('preferred_categories').optional().isArray(),
  body('home_lat').optional().isFloat(),
  body('home_lng').optional().isFloat(),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error', 400, 'VALIDATION_ERROR');
    }

    const userId = req.headers['x-user-id'] as string;
    
    if (!userId) {
      throw createError('Not authenticated', 401, 'UNAUTHORIZED');
    }

    const {
      children_ages,
      preferred_radius_km,
      preferred_categories,
      home_lat,
      home_lng
    } = req.body;

    const profile = await prisma.familyProfile.update({
      where: { user_id: userId },
      data: {
        ...(children_ages !== undefined && { children_ages }),
        ...(preferred_radius_km !== undefined && { preferred_radius_km }),
        ...(preferred_categories !== undefined && { preferred_categories }),
        ...(home_lat !== undefined && { home_lat }),
        ...(home_lng !== undefined && { home_lng }),
      }
    });

    res.json({
      success: true,
      data: profile
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/user/saved-events - Get saved events
router.get('/saved-events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    
    if (!userId) {
      throw createError('Not authenticated', 401, 'UNAUTHORIZED');
    }

    const savedEvents = await prisma.savedEvent.findMany({
      where: { user_id: userId },
      include: {
        event: {
          include: {
            categories: {
              include: { category: true }
            },
            scores: true
          }
        }
      },
      orderBy: { saved_at: 'desc' }
    });

    res.json({
      success: true,
      data: savedEvents.map(se => ({
        ...se.event,
        saved_at: se.saved_at
      }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/user/saved-events/:eventId - Save an event
router.post('/saved-events/:eventId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const { eventId } = req.params;
    
    if (!userId) {
      throw createError('Not authenticated', 401, 'UNAUTHORIZED');
    }

    // Check if event exists
    const event = await prisma.canonicalEvent.findUnique({
      where: { id: eventId }
    });

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    // Check if already saved
    const existing = await prisma.savedEvent.findUnique({
      where: {
        user_id_event_id: {
          user_id: userId,
          event_id: eventId
        }
      }
    });

    if (existing) {
      return res.json({
        success: true,
        message: 'Event already saved'
      });
    }

    // Save event
    await prisma.savedEvent.create({
      data: {
        user_id: userId,
        event_id: eventId
      }
    });

    res.status(201).json({
      success: true,
      message: 'Event saved'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/user/saved-events/:eventId - Unsave an event
router.delete('/saved-events/:eventId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const { eventId } = req.params;
    
    if (!userId) {
      throw createError('Not authenticated', 401, 'UNAUTHORIZED');
    }

    await prisma.savedEvent.delete({
      where: {
        user_id_event_id: {
          user_id: userId,
          event_id: eventId
        }
      }
    });

    res.json({
      success: true,
      message: 'Event removed from saved'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/user/plans - Get user's plans
router.get('/plans', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    
    if (!userId) {
      throw createError('Not authenticated', 401, 'UNAUTHORIZED');
    }

    const plans = await prisma.plan.findMany({
      where: { user_id: userId },
      include: {
        slots: {
          include: {
            event: {
              select: {
                id: true,
                title: true,
                location_address: true
              }
            }
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    res.json({
      success: true,
      data: plans
    });
  } catch (error) {
    next(error);
  }
});

export default router;
