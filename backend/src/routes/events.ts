import { Router, Request, Response, NextFunction } from 'express';
import { query, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';

const router = Router();

// Validation middleware
const validateSearchParams = [
  query('lat').optional().isFloat({ min: -90, max: 90 }),
  query('lng').optional().isFloat({ min: -180, max: 180 }),
  query('radius').optional().isInt({ min: 1, max: 100 }),
  query('date').optional().isISO8601(),
  query('dateEnd').optional().isISO8601(),
  query('ageMin').optional().isInt({ min: 0, max: 18 }),
  query('ageMax').optional().isInt({ min: 0, max: 18 }),
  query('priceMax').optional().isFloat({ min: 0 }),
  query('categories').optional().isString(),
  query('indoor').optional().isBoolean(),
  query('outdoor').optional().isBoolean(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
];

// GET /api/events - Search events with filters
router.get('/', validateSearchParams, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error', 400, 'VALIDATION_ERROR');
    }

    const {
      lat,
      lng,
      radius = 20,
      date,
      dateEnd,
      ageMin,
      ageMax,
      priceMax,
      categories,
      indoor,
      outdoor,
      q,
      page = 1,
      limit = 20,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    // Build where clause
    const where: any = {
      status: 'published',
    };

    // Date filter
    if (date) {
      where.start_datetime = {
        gte: new Date(date as string),
      };
    } else {
      // Default: only future events
      where.start_datetime = {
        gte: new Date(),
      };
    }

    if (dateEnd) {
      where.start_datetime = {
        ...where.start_datetime,
        lte: new Date(dateEnd as string),
      };
    }

    // Age filter
    if (ageMin) {
      where.age_max = { gte: Number(ageMin) };
    }
    if (ageMax) {
      where.age_min = { lte: Number(ageMax) };
    }

    // Price filter
    if (priceMax !== undefined) {
      if (Number(priceMax) === 0) {
        where.price_type = 'free';
      } else {
        where.OR = [
          { price_type: 'free' },
          { price_min: { lte: Number(priceMax) } },
        ];
      }
    }

    // Indoor/Outdoor filter
    if (indoor === 'true' && outdoor !== 'true') {
      where.is_indoor = true;
    } else if (outdoor === 'true' && indoor !== 'true') {
      where.is_outdoor = true;
    }

    // Category filter
    if (categories) {
      const categoryList = (categories as string).split(',');
      where.categories = {
        some: {
          category: {
            slug: { in: categoryList }
          }
        }
      };
    }

    // Text search
    if (q) {
      where.OR = [
        { title: { contains: q as string, mode: 'insensitive' } },
        { description_short: { contains: q as string, mode: 'insensitive' } },
      ];
    }

    // TODO: Implement geo search with PostGIS
    // For now, we'll skip geo filtering and add it later

    // Execute query
    const [events, total] = await Promise.all([
      prisma.canonicalEvent.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: [
          { start_datetime: 'asc' },
        ],
        include: {
          categories: {
            include: {
              category: true
            }
          },
          scores: true,
          provider: {
            select: {
              id: true,
              name: true,
              type: true,
            }
          }
        }
      }),
      prisma.canonicalEvent.count({ where }),
    ]);

    res.json({
      success: true,
      data: events,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/featured - Get featured events
router.get('/featured', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const events = await prisma.canonicalEvent.findMany({
      where: {
        status: 'published',
        start_datetime: { gte: new Date() },
        is_complete: true,
      },
      orderBy: [
        { scores: { family_fit_score: 'desc' } },
        { start_datetime: 'asc' },
      ],
      take: 6,
      include: {
        categories: {
          include: {
            category: true
          }
        },
        scores: true,
      }
    });

    res.json({
      success: true,
      data: events,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/:id - Get single event by ID
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const event = await prisma.canonicalEvent.findUnique({
      where: { id },
      include: {
        categories: {
          include: {
            category: true
          }
        },
        scores: true,
        amenities: {
          include: {
            amenity: true
          }
        },
        provider: true,
        primary_source: {
          include: {
            source: true
          }
        }
      }
    });

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    res.json({
      success: true,
      data: event,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/:id/similar - Get similar events
router.get('/:id/similar', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const event = await prisma.canonicalEvent.findUnique({
      where: { id },
      include: {
        categories: true
      }
    });

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const categoryIds = event.categories?.map(c => c.category_id) || [];

    const similarEvents = await prisma.canonicalEvent.findMany({
      where: {
        id: { not: id },
        status: 'published',
        start_datetime: { gte: new Date() },
        categories: categoryIds.length > 0 ? {
          some: {
            category_id: { in: categoryIds }
          }
        } : undefined
      },
      orderBy: { start_datetime: 'asc' },
      take: 4,
      include: {
        categories: {
          include: {
            category: true
          }
        },
        scores: true,
      }
    });

    res.json({
      success: true,
      data: similarEvents,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
