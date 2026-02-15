import { Router, Request, Response, NextFunction } from 'express';
import { query, body, validationResult } from 'express-validator';
import { Prisma, EventStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { 
  generateIdempotencyKey, 
  computeFingerprint, 
  findExistingEventSource,
  findDuplicateByFingerprint,
  SOURCE_PRIORITY,
  shouldUpdateField,
  type IngestResult 
} from '../lib/idempotency.js';
import { calculateCompleteness, determineInitialStatus } from '../lib/eventCompleteness.js';
import { 
  parsePaginationParams, 
  createPaginationResult, 
  getEventSortConfig,
  getDateRangeFilter,
  MAX_LIMIT,
  type EventSortOption 
} from '../lib/pagination.js';
import { 
  computeChangeset, 
  createEventRevision 
} from '../lib/eventRevision.js';
import { searchEventsWithinRadius, addDistanceToEvents } from '../lib/geo.js';
import { whereDisplayable, whereDisplayableWith, canPublish, RESTRICTED_AGE_RATINGS } from '../lib/eventQuery.js';
import {
  computeTotalScore,
  assignBadges,
  buildWhyRecommended,
  reRank,
  type EventWithScores,
} from '../lib/tagestippScore.js';
import { optionalAuth, requireAuth, requireServiceToken, type AuthRequest } from '../middleware/auth.js';
import crypto from 'crypto';
import { sendEventSubmittedEmail } from '../lib/email.js';

const router = Router();

// Validation middleware
const validateSearchParams = [
  query('lat').optional().isFloat({ min: -90, max: 90 }),
  query('lng').optional().isFloat({ min: -180, max: 180 }),
  query('radius').optional().isInt({ min: 1, max: 100 }),
  query('dateFrom').optional().isISO8601(),
  query('dateTo').optional().isISO8601(),
  query('date').optional().isISO8601(), // Legacy support
  query('dateEnd').optional().isISO8601(), // Legacy support
  query('ageMin').optional().isInt({ min: 0, max: 99 }),
  query('ageMax').optional().isInt({ min: 0, max: 99 }),
  query('priceMax').optional().isFloat({ min: 0 }),
  query('categories').optional().isString(),
  query('indoor').optional().isBoolean(),
  query('outdoor').optional().isBoolean(),
  query('free').optional().isBoolean(),
  query('sort').optional().isIn(['soonest', 'nearest', 'newest', 'relevance']),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: MAX_LIMIT }),
  query('includeCancelled').optional().isBoolean(),
];

// GET /api/events - Search events with filters
router.get('/', validateSearchParams, async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error', 400, 'VALIDATION_ERROR');
    }

    const {
      lat,
      lng,
      radius = 20,
      dateFrom,
      dateTo,
      date, // Legacy
      dateEnd, // Legacy
      ageMin,
      ageMax,
      priceMax,
      categories,
      indoor,
      outdoor,
      free,
      q,
      tab,
      sort = 'soonest',
      includeCancelled,
    } = req.query;

    // Parse pagination
    const { page, limit, skip } = parsePaginationParams(req.query);

    // Build where clause - start with displayable base filter
    const now = new Date();
    const baseFilter = whereDisplayable(now);
    const where: any = {
      ...baseFilter,
      // Override is_cancelled if includeCancelled is set
      is_cancelled: includeCancelled === 'true' ? undefined : false,
    };

    // Tab-based filtering
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    if (tab) {
      switch (tab) {
        case 'heute':
          where.start_datetime = { gte: today, lt: tomorrow };
          break;
        case 'wochenende': {
          const dayOfWeek = now.getDay();
          const daysUntilSaturday = dayOfWeek === 0 ? 6 : 6 - dayOfWeek;
          const saturday = new Date(today);
          saturday.setDate(saturday.getDate() + daysUntilSaturday);
          const monday = new Date(saturday);
          monday.setDate(monday.getDate() + 2);
          where.start_datetime = { gte: saturday, lt: monday };
          break;
        }
        case 'ferien':
          // Would need a holiday calendar - for now show next 30 days
          const thirtyDays = new Date(today);
          thirtyDays.setDate(thirtyDays.getDate() + 30);
          where.start_datetime = { gte: today, lt: thirtyDays };
          break;
        case 'nachmittags': {
          // Events starting at or after 14:00
          const afternoon = new Date(today);
          afternoon.setHours(14, 0, 0, 0);
          where.start_datetime = { gte: afternoon };
          break;
        }
        case 'regen':
          where.is_indoor = true;
          where.start_datetime = { gte: now };
          break;
        case 'kostenlos':
          where.price_type = 'free';
          where.start_datetime = { gte: now };
          break;
        default:
          where.start_datetime = { gte: now };
      }
    } else if (dateFrom || dateTo || date || dateEnd) {
      // New date range filter or legacy support
      const fromDate = dateFrom || date;
      const toDate = dateTo || dateEnd;
      where.start_datetime = getDateRangeFilter(fromDate as string, toDate as string);
    } else {
      // Default: only future events
      where.start_datetime = { gte: new Date() };
    }

    // Age filter
    if (ageMin) {
      where.age_max = { gte: Number(ageMin) };
    }
    if (ageMax) {
      where.age_min = { lte: Number(ageMax) };
    }

    // Price filter
    if (free === 'true') {
      where.price_type = 'free';
    } else if (priceMax !== undefined) {
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

    // Get sort configuration
    const sortConfig = getEventSortConfig(sort as EventSortOption);

    // Use PostGIS for geo-based queries
    const userLat = lat ? parseFloat(lat as string) : null;
    const userLng = lng ? parseFloat(lng as string) : null;
    const radiusKm = radius ? parseInt(radius as string) : 20;

    let events: any[];
    let total: number;

    if ((sort === 'nearest' || (userLat && userLng && radiusKm)) && userLat && userLng) {
      // Use PostGIS geo search
      const geoResult = await searchEventsWithinRadius(userLat, userLng, radiusKm, {
        limit,
        offset: skip,
        status: 'published',
        includeCancelled: includeCancelled === 'true',
        dateFrom: where.start_datetime?.gte,
        dateTo: where.start_datetime?.lte,
      });

      events = geoResult.events;
      total = geoResult.total;

      // Fetch related data for each event (categories, scores, provider)
      const eventIds = events.map(e => e.id);
      if (eventIds.length > 0) {
        const [categoriesData, scoresData, providersData] = await Promise.all([
          prisma.eventCategory.findMany({
            where: { event_id: { in: eventIds } },
            include: { category: true }
          }),
          prisma.eventScore.findMany({
            where: { event_id: { in: eventIds } }
          }),
          prisma.provider.findMany({
            where: { id: { in: events.filter(e => e.provider_id).map(e => e.provider_id) } },
            select: { id: true, name: true, type: true }
          })
        ]);

        // Map relations to events
        const categoriesMap = new Map<string, any[]>();
        categoriesData.forEach(ec => {
          if (!categoriesMap.has(ec.event_id)) categoriesMap.set(ec.event_id, []);
          categoriesMap.get(ec.event_id)!.push(ec);
        });

        const scoresMap = new Map(scoresData.map(s => [s.event_id, s]));
        const providersMap = new Map(providersData.map(p => [p.id, p]));

        events = events.map(e => ({
          ...e,
          categories: categoriesMap.get(e.id) || [],
          scores: scoresMap.get(e.id) || null,
          provider: e.provider_id ? providersMap.get(e.provider_id) || null : null,
        }));
      }
    } else {
      // Standard Prisma query
      [events, total] = await Promise.all([
        prisma.canonicalEvent.findMany({
          where,
          skip,
          take: limit,
          orderBy: sortConfig.orderBy,
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
            },
            rescheduled_to: {
              select: {
                id: true,
                title: true,
                start_datetime: true,
              }
            }
          }
        }),
        prisma.canonicalEvent.count({ where }),
      ]);

      // Add distance if user location provided
      if (userLat && userLng) {
        events = addDistanceToEvents(events, userLat, userLng);
      }
    }

    const pagination = createPaginationResult(page, limit, total);
    const queryTimeMs = Date.now() - startTime;

    res.json({
      success: true,
      data: events,
      pagination,
      meta: {
        query_time_ms: queryTimeMs,
        sort: sort as string,
        filters_applied: Object.keys(req.query).filter(k => !['page', 'limit', 'sort'].includes(k)),
        geo: userLat && userLng ? { lat: userLat, lng: userLng, radius_km: radiusKm } : undefined,
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/top-picks - Get top picks based on score and relevance
router.get('/top-picks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);
    
    // Use central displayable filter (no is_complete filter!)
    const where = whereDisplayable();

    const [events, total] = await Promise.all([
      prisma.canonicalEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { scores: { stressfree_score: 'desc' } },
          { scores: { family_fit_score: 'desc' } },
          { start_datetime: 'asc' },
        ],
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
        }
      }),
      prisma.canonicalEvent.count({ where }),
    ]);

    res.json({
      success: true,
      data: events,
      pagination: createPaginationResult(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/available - Get events with available spots today
router.get('/available', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Use central displayable filter + today filter
    const where = whereDisplayableWith(today, {
      start_datetime: { lt: tomorrow }
    });

    const [events, total] = await Promise.all([
      prisma.canonicalEvent.findMany({
        where,
        skip,
        take: limit,
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
        }
      }),
      prisma.canonicalEvent.count({ where }),
    ]);

    res.json({
      success: true,
      data: events,
      pagination: createPaginationResult(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/new - Get newly added events (last 7 days)
router.get('/new', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    // Use central displayable filter + created_at filter
    const where = whereDisplayableWith(new Date(), {
      created_at: { gte: oneWeekAgo },
    });

    const [events, total] = await Promise.all([
      prisma.canonicalEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { created_at: 'desc' },
        ],
        include: {
          categories: {
            include: {
              category: true
            }
          },
          scores: true,
        }
      }),
      prisma.canonicalEvent.count({ where }),
    ]);

    res.json({
      success: true,
      data: events,
      pagination: createPaginationResult(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/trending - Get trending events (most viewed/saved)
router.get('/trending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);
    
    // Use central displayable filter (no is_complete filter!)
    const where = whereDisplayable();

    const [events, total] = await Promise.all([
      prisma.canonicalEvent.findMany({
        where,
        skip,
        take: limit,
        // Order by engagement metrics (view_count + save_count * 5 for weighted importance)
        orderBy: [
          { save_count: 'desc' },
          { view_count: 'desc' },
          { start_datetime: 'asc' },
        ],
        include: {
          categories: {
            include: {
              category: true
            }
          },
          scores: true,
        }
      }),
      prisma.canonicalEvent.count({ where }),
    ]);

    res.json({
      success: true,
      data: events,
      pagination: createPaginationResult(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/featured - Get featured events
router.get('/featured', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip } = parsePaginationParams({ ...req.query, limit: req.query.limit || '6' });
    
    // Use central displayable filter (no is_complete filter!)
    const where = whereDisplayable();

    const [events, total] = await Promise.all([
      prisma.canonicalEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { scores: { family_fit_score: 'desc' } },
          { start_datetime: 'asc' },
        ],
        include: {
          categories: {
            include: {
              category: true
            }
          },
          scores: true,
        }
      }),
      prisma.canonicalEvent.count({ where }),
    ]);

    res.json({
      success: true,
      data: events,
      pagination: createPaginationResult(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/events/tagestipp - Tagestipps für heute (Ranking, Badges, optional why_recommended)
router.get('/tagestipp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '6'), 10) || 6, 20);
    const lat = req.query.lat ? parseFloat(String(req.query.lat)) : null;
    const lng = req.query.lng ? parseFloat(String(req.query.lng)) : null;
    const dateParam = req.query.date as string | undefined;

    const now = new Date();
    const today = dateParam
      ? (() => {
          const d = new Date(dateParam);
          d.setHours(0, 0, 0, 0);
          return d;
        })()
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const where = whereDisplayableWith(now, {
      start_datetime: { gte: today, lt: tomorrow },
    });

    let events = await prisma.canonicalEvent.findMany({
      where,
      take: 50,
      orderBy: [{ start_datetime: 'asc' }],
      include: {
        categories: { include: { category: true } },
        scores: true,
      },
    });

    events = events.filter((e) => canPublish(e).valid);

    if (lat != null && lng != null) {
      events = addDistanceToEvents(events, lat, lng);
    }

    const scored: EventWithScores[] = events.map((event) => {
      const { components, total } = computeTotalScore(event);
      return { event, scoreComponents: components, totalScore: total };
    });

    const sorted = scored.sort((a, b) => b.totalScore - a.totalScore);
    const reranked = reRank(sorted, limit);

    const subline = 'Top Picks heute';
    const intent_label = null;

    const data = reranked.map(({ event, scoreComponents }) => {
      const badges = assignBadges(event, events);
      const why_recommended = buildWhyRecommended(event);
      const out: any = {
        ...event,
        badges: badges as string[],
        score_components: {
          popularity: scoreComponents.popularity,
          match: scoreComponents.match,
          freshness: scoreComponents.freshness,
          distance: scoreComponents.distance,
        },
      };
      if (why_recommended) out.why_recommended = why_recommended;
      if (event.distance_km != null) out.distance_km = event.distance_km;
      if (event.distance_meters != null) out.distance_meters = event.distance_meters;
      return out;
    });

    res.json({
      success: true,
      data,
      pagination: createPaginationResult(1, limit, data.length),
      subline,
      intent_label,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// CREATE EVENT (Manual/Provider)
// ============================================

const validateCreateEvent = [
  body('title').isString().isLength({ min: 3, max: 200 }).withMessage('title required (3-200 chars)'),
  body('start_datetime').isISO8601().withMessage('start_datetime must be ISO8601'),
  body('end_datetime').optional().isISO8601(),
  body('is_all_day').optional().isBoolean(),
  body('description_short').optional().isString().isLength({ max: 500 }),
  body('description_long').optional().isString(),
  body('location_address').optional().isString().isLength({ max: 300 }),
  body('location_lat').optional().isFloat({ min: -90, max: 90 }),
  body('location_lng').optional().isFloat({ min: -180, max: 180 }),
  body('price_type').optional().isIn(['free', 'paid', 'range', 'unknown']),
  body('price_min').optional().isFloat({ min: 0 }),
  body('price_max').optional().isFloat({ min: 0 }),
  body('age_min').optional().isInt({ min: 0, max: 99 }),
  body('age_max').optional().isInt({ min: 0, max: 99 }),
  body('is_indoor').optional().isBoolean(),
  body('is_outdoor').optional().isBoolean(),
  body('booking_url').optional().isURL(),
  body('contact_email').optional().isEmail(),
  body('contact_phone').optional().isString(),
  body('categories').optional().isArray(),
];

// POST /api/events - Create a new event (requires authentication)
router.post('/', requireAuth, validateCreateEvent, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error: ' + errors.array().map(e => e.msg).join(', '), 400, 'VALIDATION_ERROR');
    }

    const {
      title,
      description_short,
      description_long,
      start_datetime,
      end_datetime,
      is_all_day,
      location_address,
      location_district,
      location_lat,
      location_lng,
      price_type,
      price_min,
      price_max,
      age_min,
      age_max,
      is_indoor,
      is_outdoor,
      booking_url,
      contact_email,
      contact_phone,
      image_urls,
      categories: categorySlugs,
    } = req.body;

    // Prepare event data
    const eventData: any = {
      title,
      description_short: description_short || null,
      description_long: description_long || null,
      start_datetime: new Date(start_datetime),
      end_datetime: end_datetime ? new Date(end_datetime) : null,
      is_all_day: is_all_day || false,
      location_address: location_address || null,
      location_district: location_district || null,
      location_lat: location_lat ? parseFloat(location_lat) : null,
      location_lng: location_lng ? parseFloat(location_lng) : null,
      price_type: price_type || 'unknown',
      price_min: price_min ? parseFloat(price_min) : null,
      price_max: price_max ? parseFloat(price_max) : null,
      age_min: age_min ? parseInt(age_min) : null,
      age_max: age_max ? parseInt(age_max) : null,
      is_indoor: is_indoor || false,
      is_outdoor: is_outdoor || false,
      booking_url: booking_url || null,
      contact_email: contact_email || null,
      contact_phone: contact_phone || null,
      image_urls: image_urls || [],
    };

    // Check if user is a provider and link to their provider ID
    const provider = await prisma.provider.findUnique({
      where: { user_id: req.user!.sub }
    });

    if (provider) {
      // Check if provider is verified before allowing event creation
      if (!provider.is_verified) {
        throw createError(
          'Provider not verified. Please wait for admin verification before creating events.',
          403,
          'PROVIDER_NOT_VERIFIED'
        );
      }
      eventData.provider_id = provider.id;
    } else if (req.user!.role !== 'admin') {
      // Only admins can create events without a provider profile
      throw createError(
        'Provider profile required to create events. Please create a provider profile first.',
        403,
        'PROVIDER_REQUIRED'
      );
    }

    // Calculate completeness
    const completeness = calculateCompleteness(eventData);
    const initialStatus = determineInitialStatus(completeness);

    // Create event
    const event = await prisma.canonicalEvent.create({
      data: {
        ...eventData,
        status: initialStatus,
        is_complete: completeness.isComplete,
        completeness_score: completeness.score,
      }
    });

    // Add categories if provided
    if (categorySlugs && Array.isArray(categorySlugs) && categorySlugs.length > 0) {
      const categories = await prisma.category.findMany({
        where: { slug: { in: categorySlugs } }
      });
      
      for (const cat of categories) {
        await prisma.eventCategory.create({
          data: {
            event_id: event.id,
            category_id: cat.id,
          }
        }).catch(() => {}); // Ignore if already exists
      }
    }

    // Fetch the created event with relations
    const createdEvent = await prisma.canonicalEvent.findUnique({
      where: { id: event.id },
      include: {
        categories: {
          include: { category: true }
        },
        provider: true,
      }
    });

    // Send event submitted confirmation email to provider (non-blocking)
    if (provider) {
      sendEventSubmittedEmail(req.user!.email, title, event.id).catch(err => {
        console.error('Failed to send event submitted email:', err);
      });
    }

    res.status(201).json({
      success: true,
      message: `Event created with status '${initialStatus}'`,
      data: createdEvent,
      completeness: {
        score: completeness.score,
        is_complete: completeness.isComplete,
        missing_fields: completeness.missingFields,
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// INGEST ENDPOINT (for AI-Worker)
// ============================================

const validateIngestPayload = [
  body('source_id').isUUID().withMessage('source_id must be a valid UUID'),
  body('title').isString().isLength({ min: 3, max: 200 }).withMessage('title required (3-200 chars)'),
  body('start_datetime').isISO8601().withMessage('start_datetime must be ISO8601'),
  body('end_datetime').optional().isISO8601(),
  body('location_address').optional().isString().isLength({ max: 300 }),
  body('location_lat').optional().isFloat({ min: -90, max: 90 }),
  body('location_lng').optional().isFloat({ min: -180, max: 180 }),
  body('price_type').optional().isIn(['free', 'paid', 'range', 'unknown']),
  body('price_min').optional().isFloat({ min: 0 }),
  body('price_max').optional().isFloat({ min: 0 }),
  body('age_min').optional().isInt({ min: 0, max: 99 }),
  body('age_max').optional().isInt({ min: 0, max: 99 }),
  body('external_id').optional().isString().isLength({ max: 255 }),
  body('source_url').optional().isURL(),
  body('raw_data').optional().isObject(),
];

// POST /api/events/ingest - Ingest event from AI-Worker (idempotent)
router.post('/ingest', validateIngestPayload, async (req: Request, res: Response, next: NextFunction) => {
  const correlationId = req.headers['x-correlation-id'] as string || crypto.randomUUID().substring(0, 8);
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error: ' + errors.array().map(e => e.msg).join(', '), 400, 'VALIDATION_ERROR');
    }

    const {
      source_id,
      title,
      description_short,
      description_long,
      start_datetime,
      end_datetime,
      is_all_day,
      location_address,
      location_district,
      location_lat,
      location_lng,
      price_type,
      price_min,
      price_max,
      age_min,
      age_max,
      is_indoor,
      is_outdoor,
      booking_url,
      contact_email,
      contact_phone,
      image_urls,
      external_id,
      source_url,
      raw_data,
      normalized_data,
      categories: categorySlugs,
    } = req.body;

    // 1. Verify source exists and get its priority
    const source = await prisma.source.findUnique({ where: { id: source_id } });
    if (!source) {
      throw createError('Source not found', 404, 'SOURCE_NOT_FOUND');
    }
    const sourcePriority = SOURCE_PRIORITY[source.type] || 5;

    // 2. Compute fingerprint
    const fingerprint = computeFingerprint(
      title,
      start_datetime,
      location_lat ? parseFloat(location_lat) : null,
      location_lng ? parseFloat(location_lng) : null
    );

    // 3. Generate idempotency key
    const idempotencyKey = generateIdempotencyKey(source_id, fingerprint, start_datetime);

    // 4. Check for existing EventSource (idempotent check)
    const existing = await findExistingEventSource(fingerprint, source_id);

    if (existing) {
      // Same source, same fingerprint - update EventSource only
      await prisma.eventSource.update({
        where: { id: existing.eventSource.id },
        data: {
          fetched_at: new Date(),
          normalized_data: normalized_data || req.body,
          raw_data: raw_data || null,
        }
      });

      // Check if we should update canonical event fields
      if (existing.canonicalEvent) {
        const lockedFields = (existing.canonicalEvent.locked_fields as string[]) || [];
        const existingPriority = existing.canonicalEvent.primary_source?.source 
          ? SOURCE_PRIORITY[existing.canonicalEvent.primary_source.source.type] || 5
          : 5;

        const updates: any = {};
        const fieldsUpdated: string[] = [];

        // Only update fields if new source has higher priority and field is not locked
        const fieldsToCheck = [
          { name: 'description_short', value: description_short },
          { name: 'description_long', value: description_long },
          { name: 'location_address', value: location_address },
          { name: 'location_district', value: location_district },
          { name: 'price_type', value: price_type },
          { name: 'price_min', value: price_min },
          { name: 'price_max', value: price_max },
          { name: 'booking_url', value: booking_url },
          { name: 'contact_email', value: contact_email },
          { name: 'contact_phone', value: contact_phone },
        ];

        for (const field of fieldsToCheck) {
          if (field.value !== undefined && shouldUpdateField(field.name, existingPriority, sourcePriority, lockedFields)) {
            updates[field.name] = field.value;
            fieldsUpdated.push(field.name);
          }
        }

        if (Object.keys(updates).length > 0) {
          await prisma.canonicalEvent.update({
            where: { id: existing.canonicalEvent.id },
            data: updates
          });
        }

        const result: IngestResult = {
          action: fieldsUpdated.length > 0 ? 'updated' : 'skipped',
          eventId: existing.canonicalEvent.id,
          eventSourceId: existing.eventSource.id,
          message: fieldsUpdated.length > 0 
            ? `Updated ${fieldsUpdated.length} fields`
            : 'No updates needed (same or lower priority source)',
          fieldsUpdated,
        };

        return res.json({
          success: true,
          data: result,
          idempotency_key: idempotencyKey,
          correlation_id: correlationId,
        });
      }
    }

    // 5. Check for duplicate across other sources
    const duplicateEvent = await findDuplicateByFingerprint(fingerprint);

    // 6. Prepare event data
    const eventData = {
      title,
      description_short: description_short || null,
      description_long: description_long || null,
      start_datetime: new Date(start_datetime),
      end_datetime: end_datetime ? new Date(end_datetime) : null,
      is_all_day: is_all_day || false,
      location_address: location_address || null,
      location_district: location_district || null,
      location_lat: location_lat ? parseFloat(location_lat) : null,
      location_lng: location_lng ? parseFloat(location_lng) : null,
      price_type: price_type || 'unknown',
      price_min: price_min ? parseFloat(price_min) : null,
      price_max: price_max ? parseFloat(price_max) : null,
      age_min: age_min ? parseInt(age_min) : null,
      age_max: age_max ? parseInt(age_max) : null,
      is_indoor: is_indoor || false,
      is_outdoor: is_outdoor || false,
      booking_url: booking_url || null,
      contact_email: contact_email || null,
      contact_phone: contact_phone || null,
      image_urls: image_urls || [],
    };

    // 7. Calculate completeness
    const completeness = calculateCompleteness(eventData);
    const initialStatus = determineInitialStatus(completeness);

    // 8. Create or link to canonical event
    let canonicalEventId: string;
    let action: 'created' | 'updated' | 'duplicate';

    if (duplicateEvent) {
      // Link to existing event
      canonicalEventId = duplicateEvent.id;
      action = 'duplicate';
    } else {
      // Create new canonical event
      const newEvent = await prisma.canonicalEvent.create({
        data: {
          ...eventData,
          status: initialStatus as EventStatus,
          is_complete: completeness.isComplete,
          completeness_score: completeness.score,
        }
      });
      canonicalEventId = newEvent.id;
      action = 'created';

      // Add categories if provided
      if (categorySlugs && Array.isArray(categorySlugs) && categorySlugs.length > 0) {
        const categories = await prisma.category.findMany({
          where: { slug: { in: categorySlugs } }
        });
        
        for (const cat of categories) {
          await prisma.eventCategory.create({
            data: {
              event_id: canonicalEventId,
              category_id: cat.id,
            }
          }).catch(() => {}); // Ignore if already exists
        }
      }
    }

    // 9. Create EventSource
    const eventSource = await prisma.eventSource.create({
      data: {
        canonical_event_id: canonicalEventId,
        source_id,
        external_id: external_id || null,
        source_url: source_url || null,
        raw_data: raw_data || null,
        normalized_data: normalized_data || req.body,
        fingerprint,
      }
    });

    // 10. Set as primary source if new event
    if (action === 'created') {
      await prisma.canonicalEvent.update({
        where: { id: canonicalEventId },
        data: { primary_source_id: eventSource.id }
      });
    }

    const result: IngestResult = {
      action,
      eventId: canonicalEventId,
      eventSourceId: eventSource.id,
      message: action === 'created' 
        ? `New event created with status '${initialStatus}'`
        : action === 'duplicate'
        ? 'Linked to existing event (duplicate fingerprint)'
        : 'Event updated',
    };

    res.status(action === 'created' ? 201 : 200).json({
      success: true,
      data: result,
      idempotency_key: idempotencyKey,
      correlation_id: correlationId,
      completeness: {
        score: completeness.score,
        is_complete: completeness.isComplete,
        missing_fields: completeness.missingFields,
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// BATCH INGEST ENDPOINT (for AI-Worker)
// ============================================

import { processBatch, type CanonicalCandidate } from '../lib/merge.js';

interface IngestBatchRequest {
  run_id?: string;
  source_id: string;
  candidates: CanonicalCandidate[];
}

// POST /api/events/ingest/batch - Batch ingest events from AI-Worker (requires SERVICE_TOKEN)
router.post('/ingest/batch', requireServiceToken, async (req: Request, res: Response, next: NextFunction) => {
  const correlationId = req.headers['x-correlation-id'] as string || crypto.randomUUID().substring(0, 8);
  // #region agent log
  const _body = req.body as IngestBatchRequest;
  fetch('http://127.0.0.1:7245/ingest/5d9bb467-7a30-458e-a7a6-30ea6b541c63', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'events.ts:ingest/batch_start', message: 'batch ingest request received', data: { candidates_count: _body?.candidates?.length ?? 0, run_id: _body?.run_id, source_id: _body?.source_id }, timestamp: Date.now(), hypothesisId: 'H2,H3,H5' }) }).catch(() => {});
  // #endregion
  try {
    const { run_id, source_id, candidates } = req.body as IngestBatchRequest;
    
    if (!source_id) {
      throw createError('source_id is required', 400, 'VALIDATION_ERROR');
    }
    
    if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
      throw createError('candidates array is required and must not be empty', 400, 'VALIDATION_ERROR');
    }
    
    // Verify source exists
    const source = await prisma.source.findUnique({ where: { id: source_id } });
    if (!source) {
      throw createError('Source not found', 404, 'SOURCE_NOT_FOUND');
    }
    
    // Create or use existing IngestRun
    let ingestRunId = run_id;
    if (!ingestRunId) {
      const ingestRun = await prisma.ingestRun.create({
        data: {
          correlation_id: correlationId,
          source_id: source_id,
          status: 'running',
        }
      });
      ingestRunId = ingestRun.id;
    }
    
    // Process batch
    const { results, summary } = await processBatch(candidates, source_id, ingestRunId);
    // #region agent log
    fetch('http://127.0.0.1:7245/ingest/5d9bb467-7a30-458e-a7a6-30ea6b541c63', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'events.ts:ingest/batch_after_processBatch', message: 'processBatch completed', data: { run_id: ingestRunId, summary, candidates_count: candidates.length }, timestamp: Date.now(), hypothesisId: 'H3,H5' }) }).catch(() => {});
    // #endregion
    // Update source health on success
    if (summary.created > 0 || summary.updated > 0) {
      await prisma.source.update({
        where: { id: source_id },
        data: {
          last_success_at: new Date(),
          last_fetch_at: new Date(),
          health_status: 'healthy',
          consecutive_failures: 0,
          avg_events_per_fetch: candidates.length,
        }
      });
    }
    
    res.json({
      success: true,
      run_id: ingestRunId,
      correlation_id: correlationId,
      results,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// CANCEL / RESCHEDULE ENDPOINTS
// ============================================

// POST /api/events/:id/cancel - Cancel an event
router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const event = await prisma.canonicalEvent.findUnique({ where: { id } });
    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    if (event.is_cancelled) {
      throw createError('Event is already cancelled', 400, 'ALREADY_CANCELLED');
    }

    const updated = await prisma.canonicalEvent.update({
      where: { id },
      data: {
        is_cancelled: true,
        cancelled_at: new Date(),
        cancellation_reason: reason || null,
        status: 'cancelled',
      }
    });

    res.json({
      success: true,
      message: 'Event cancelled',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/events/:id/reschedule - Reschedule an event
router.post('/:id/reschedule', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { new_start_datetime, new_end_datetime, reason } = req.body;

    if (!new_start_datetime) {
      throw createError('new_start_datetime is required', 400, 'VALIDATION_ERROR');
    }

    const originalEvent = await prisma.canonicalEvent.findUnique({ 
      where: { id },
      include: { categories: true }
    });
    
    if (!originalEvent) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    // Create new event with updated dates
    const newEvent = await prisma.canonicalEvent.create({
      data: {
        title: originalEvent.title,
        description_short: originalEvent.description_short,
        description_long: originalEvent.description_long,
        start_datetime: new Date(new_start_datetime),
        end_datetime: new_end_datetime ? new Date(new_end_datetime) : originalEvent.end_datetime,
        is_all_day: originalEvent.is_all_day,
        location_address: originalEvent.location_address,
        location_district: originalEvent.location_district,
        location_lat: originalEvent.location_lat,
        location_lng: originalEvent.location_lng,
        price_type: originalEvent.price_type,
        price_min: originalEvent.price_min,
        price_max: originalEvent.price_max,
        age_min: originalEvent.age_min,
        age_max: originalEvent.age_max,
        is_indoor: originalEvent.is_indoor,
        is_outdoor: originalEvent.is_outdoor,
        booking_url: originalEvent.booking_url,
        contact_email: originalEvent.contact_email,
        contact_phone: originalEvent.contact_phone,
        image_urls: originalEvent.image_urls === null ? Prisma.JsonNull : originalEvent.image_urls,
        provider_id: originalEvent.provider_id,
        status: 'pending_review',
        is_complete: originalEvent.is_complete,
        completeness_score: originalEvent.completeness_score,
      }
    });

    // Copy categories
    for (const cat of originalEvent.categories) {
      await prisma.eventCategory.create({
        data: {
          event_id: newEvent.id,
          category_id: cat.category_id,
        }
      }).catch(() => {});
    }

    // Mark original as cancelled with link to new event
    await prisma.canonicalEvent.update({
      where: { id },
      data: {
        is_cancelled: true,
        cancelled_at: new Date(),
        cancellation_reason: reason || 'Rescheduled',
        status: 'cancelled',
        rescheduled_to_event_id: newEvent.id,
        previous_start_datetime: originalEvent.start_datetime,
      }
    });

    res.status(201).json({
      success: true,
      message: 'Event rescheduled',
      data: {
        original_event_id: id,
        new_event_id: newEvent.id,
        new_start_datetime: newEvent.start_datetime,
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/events/:id/archive - Archive an event (admin)
router.post('/:id/archive', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const event = await prisma.canonicalEvent.findUnique({ where: { id } });
    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const updated = await prisma.canonicalEvent.update({
      where: { id },
      data: { status: 'archived' }
    });

    res.json({
      success: true,
      message: 'Event archived',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// UPDATE EVENT (with Revision System)
// ============================================

const validateEventUpdate = [
  body('title').optional().isString().isLength({ min: 3, max: 200 }),
  body('description_short').optional().isString().isLength({ max: 500 }),
  body('description_long').optional().isString(),
  body('start_datetime').optional().isISO8601(),
  body('end_datetime').optional().isISO8601(),
  body('is_all_day').optional().isBoolean(),
  body('location_address').optional().isString().isLength({ max: 300 }),
  body('location_lat').optional().isFloat({ min: -90, max: 90 }),
  body('location_lng').optional().isFloat({ min: -180, max: 180 }),
  body('price_type').optional().isIn(['free', 'paid', 'range', 'unknown']),
  body('price_min').optional().isFloat({ min: 0 }),
  body('price_max').optional().isFloat({ min: 0 }),
  body('age_min').optional().isInt({ min: 0, max: 99 }),
  body('age_max').optional().isInt({ min: 0, max: 99 }),
  body('is_indoor').optional().isBoolean(),
  body('is_outdoor').optional().isBoolean(),
  body('booking_url').optional().isURL(),
  body('contact_email').optional().isEmail(),
  body('contact_phone').optional().isString(),
];

// PUT /api/events/:id - Update event (creates revision for published events)
router.put('/:id', requireAuth, validateEventUpdate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error: ' + errors.array().map(e => e.msg).join(', '), 400, 'VALIDATION_ERROR');
    }

    const { id } = req.params;
    const userId = req.user!.sub;
    const isAdmin = req.user!.role === 'admin';

    const event = await prisma.canonicalEvent.findUnique({ where: { id } });
    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    // Check ownership: Only the event's provider or an admin can update
    if (!isAdmin && event.provider_id) {
      const provider = await prisma.provider.findUnique({
        where: { user_id: userId }
      });
      if (!provider || provider.id !== event.provider_id) {
        throw createError('Not authorized to edit this event', 403, 'FORBIDDEN');
      }
    }

    // Extract updatable fields from request body
    const updateData: Record<string, any> = {};
    const allowedFields = [
      'title', 'description_short', 'description_long',
      'start_datetime', 'end_datetime', 'is_all_day',
      'location_address', 'location_district', 'location_lat', 'location_lng',
      'price_type', 'price_min', 'price_max',
      'age_min', 'age_max', 'is_indoor', 'is_outdoor',
      'booking_url', 'contact_email', 'contact_phone', 'image_urls',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        let value = req.body[field];
        // Convert datetime strings to Date objects
        if ((field === 'start_datetime' || field === 'end_datetime') && typeof value === 'string') {
          value = new Date(value);
        }
        updateData[field] = value;
      }
    }

    if (Object.keys(updateData).length === 0) {
      throw createError('No fields to update', 400, 'VALIDATION_ERROR');
    }

    // For published events: create a revision instead of direct update
    if (event.status === 'published') {
      const changeset = computeChangeset(event, updateData);
      
      if (Object.keys(changeset).length === 0) {
        return res.json({
          success: true,
          message: 'No changes detected',
          data: event,
        });
      }

      const { revisionId, fieldsChanged } = await createEventRevision(
        id,
        changeset,
        userId
      );

      return res.status(202).json({
        success: true,
        message: 'Revision created for review (event is published)',
        data: {
          event_id: id,
          revision_id: revisionId,
          fields_changed: fieldsChanged,
          status: 'pending_review',
        }
      });
    }

    // For non-published events: direct update
    const updated = await prisma.canonicalEvent.update({
      where: { id },
      data: updateData,
    });

    // Recalculate completeness
    const completeness = calculateCompleteness(updated);
    await prisma.canonicalEvent.update({
      where: { id },
      data: {
        is_complete: completeness.isComplete,
        completeness_score: completeness.score,
      }
    });

    res.json({
      success: true,
      message: 'Event updated',
      data: updated,
      completeness: {
        score: completeness.score,
        is_complete: completeness.isComplete,
      }
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/events/:id - Partial update (alias for PUT)
router.patch('/:id', requireAuth, validateEventUpdate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  req.method = 'PUT';
  (router as unknown as { handle: (req: Request, res: Response, next: NextFunction) => void }).handle(req, res, next);
});

// GET /api/events/:id - Get single event by ID
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { trackView } = req.query;

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

    // Track view count (non-blocking, only when explicitly requested)
    if (trackView !== 'false') {
      prisma.canonicalEvent.update({
        where: { id },
        data: { view_count: { increment: 1 } }
      }).catch(() => {}); // Fire and forget
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

    const categoryIds = event.categories?.map((c: { category_id: string }) => c.category_id) || [];

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

// ============================================
// EXPORTS (iCal)
// ============================================

/**
 * Generate iCal content for an event
 */
function generateICalEvent(event: any): string {
  const now = new Date();
  const uid = `${event.id}@kiezling.com`;
  
  // Format dates for iCal (YYYYMMDDTHHMMSSZ format)
  const formatICalDate = (date: Date): string => {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };
  
  const dtstart = formatICalDate(new Date(event.start_datetime));
  const dtend = event.end_datetime 
    ? formatICalDate(new Date(event.end_datetime))
    : formatICalDate(new Date(new Date(event.start_datetime).getTime() + 2 * 60 * 60 * 1000)); // Default 2 hours
  const dtstamp = formatICalDate(now);
  
  // Escape special characters for iCal
  const escapeIcal = (str: string): string => {
    if (!str) return '';
    return str
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  };
  
  const title = escapeIcal(event.title);
  const description = escapeIcal(event.description_short || event.description_long || '');
  const location = escapeIcal(event.location_address || '');
  const url = event.booking_url || `https://kiezling.com/event/${event.id}`;
  
  // Build categories
  const categories = event.categories?.map((c: any) => c.category?.name_de || c.category?.slug).join(',') || '';
  
  let ical = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Kiezling//Event//DE
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:Kiezling Event
BEGIN:VEVENT
UID:${uid}
DTSTAMP:${dtstamp}
DTSTART:${dtstart}
DTEND:${dtend}
SUMMARY:${title}
DESCRIPTION:${description}
LOCATION:${location}
URL:${url}`;

  if (categories) {
    ical += `\nCATEGORIES:${escapeIcal(categories)}`;
  }
  
  if (event.location_lat && event.location_lng) {
    ical += `\nGEO:${event.location_lat};${event.location_lng}`;
  }
  
  if (event.is_cancelled) {
    ical += `\nSTATUS:CANCELLED`;
  } else {
    ical += `\nSTATUS:CONFIRMED`;
  }
  
  ical += `
END:VEVENT
END:VCALENDAR`;
  
  return ical;
}

// GET /api/events/:id.ics - Export event as iCal
router.get('/:id.ics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id.replace(/\.ics$/, '');

    const event = await prisma.canonicalEvent.findUnique({
      where: { id },
      include: {
        categories: {
          include: {
            category: true
          }
        }
      }
    });

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const icalContent = generateICalEvent(event);
    
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${event.id}.ics"`);
    res.send(icalContent);
  } catch (error) {
    next(error);
  }
});

// GET /api/events/:id/ical - Alias for iCal export
router.get('/:id/ical', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const event = await prisma.canonicalEvent.findUnique({
      where: { id },
      include: {
        categories: {
          include: {
            category: true
          }
        }
      }
    });

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const icalContent = generateICalEvent(event);
    
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${event.id}.ics"`);
    res.send(icalContent);
  } catch (error) {
    next(error);
  }
});

export default router;
