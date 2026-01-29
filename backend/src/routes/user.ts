import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';

const router = Router();

function getUserId(req: Request): string {
  return (req as AuthRequest).user!.sub;
}

// GET /api/user/profile - Get user profile
router.get('/profile', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);

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
router.put('/profile', requireAuth, [
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

    const userId = getUserId(req);

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
router.get('/saved-events', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);

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
      data: savedEvents.map((se: { event: object; saved_at: Date }) => ({
        ...se.event,
        saved_at: se.saved_at
      }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/user/saved-events/:eventId - Save an event
router.post('/saved-events/:eventId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const { eventId } = req.params;

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

    // Save event and increment save count
    await prisma.$transaction([
      prisma.savedEvent.create({
        data: {
          user_id: userId,
          event_id: eventId
        }
      }),
      prisma.canonicalEvent.update({
        where: { id: eventId },
        data: { save_count: { increment: 1 } }
      })
    ]);

    res.status(201).json({
      success: true,
      message: 'Event saved'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/user/saved-events/:eventId - Unsave an event
router.delete('/saved-events/:eventId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const { eventId } = req.params;

    // Check if saved before deleting
    const existing = await prisma.savedEvent.findUnique({
      where: {
        user_id_event_id: {
          user_id: userId,
          event_id: eventId
        }
      }
    });

    if (existing) {
      // Delete and decrement save count
      await prisma.$transaction([
        prisma.savedEvent.delete({
          where: {
            user_id_event_id: {
              user_id: userId,
              event_id: eventId
            }
          }
        }),
        prisma.canonicalEvent.update({
          where: { id: eventId },
          data: { save_count: { decrement: 1 } }
        })
      ]);
    }

    res.json({
      success: true,
      message: 'Event removed from saved'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/user/plans - Get user's plans
router.get('/plans', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);

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

// ============================================
// ICAL EXPORT
// ============================================

/**
 * Generate iCal content for an event
 */
function generateICalEvent(event: any): string {
  const uid = `${event.id}@kiezling.com`;
  
  // Format dates for iCal (YYYYMMDDTHHMMSSZ format)
  const formatICalDate = (date: Date): string => {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };
  
  const dtstart = formatICalDate(new Date(event.start_datetime));
  const dtend = event.end_datetime 
    ? formatICalDate(new Date(event.end_datetime))
    : formatICalDate(new Date(new Date(event.start_datetime).getTime() + 2 * 60 * 60 * 1000));
  const dtstamp = formatICalDate(new Date());
  
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
  const url = event.booking_url || `https://www.kiezling.com/event/${event.id}`;
  
  // Build categories
  const categories = event.categories?.map((c: any) => c.category?.name_de || c.category?.slug).join(',') || '';
  
  let ical = `BEGIN:VEVENT
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
  
  ical += `\nEND:VEVENT`;
  
  return ical;
}

// GET /api/user/saved-events.ics - Export saved events as iCal
router.get('/saved-events.ics', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);

    const savedEvents = await prisma.savedEvent.findMany({
      where: { user_id: userId },
      include: {
        event: {
          include: {
            categories: {
              include: { category: true }
            }
          }
        }
      },
      orderBy: { saved_at: 'desc' }
    });

    // Filter to only future events
    const now = new Date();
    const futureEvents = savedEvents
      .filter((se: { event: any }) => new Date(se.event.start_datetime) >= now)
      .map((se: { event: any }) => se.event);

    // Build iCal content
    const icalEvents = futureEvents.map((event: any) => generateICalEvent(event)).join('\n');
    
    const icalContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Kiezling//Merkliste//DE
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:kiezling Merkliste
X-WR-TIMEZONE:Europe/Berlin
${icalEvents}
END:VCALENDAR`;
    
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="kiezling-merkliste.ics"');
    res.send(icalContent);
  } catch (error) {
    next(error);
  }
});

export default router;
