import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { requireAuth, optionalAuth, type AuthRequest } from '../middleware/auth.js';
import { searchEventsWithinRadius } from '../lib/geo.js';
import { logger } from '../lib/logger.js';

const router = Router();

const AI_WORKER_URL = process.env.AI_WORKER_URL || 'http://localhost:5000';

// Validation for plan generation
const validatePlanRequest = [
  body('children_ages').isArray({ min: 1 }).withMessage('At least one child age required'),
  body('children_ages.*').isInt({ min: 0, max: 18 }),
  body('date').isISO8601(),
  body('budget').optional().isFloat({ min: 0 }),
  body('lat').optional().isFloat({ min: -90, max: 90 }),
  body('lng').optional().isFloat({ min: -180, max: 180 }),
  body('preferences').optional().isObject(),
];

// POST /api/plan/generate - Generate a family day plan
router.post('/generate', validatePlanRequest, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error', 400, 'VALIDATION_ERROR');
    }

    const {
      children_ages,
      date,
      budget = 50,
      lat = 49.0069, // Karlsruhe center
      lng = 8.4037,
      radius = 15, // km
      preferences = {},
      use_ai = false, // Optional: use AI for plan optimization
    } = req.body;

    // Determine age range
    const minAge = Math.min(...children_ages);
    const maxAge = Math.max(...children_ages);

    // Build query for suitable events
    const targetDate = new Date(date);
    const dayStart = new Date(targetDate);
    dayStart.setHours(8, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setHours(20, 0, 0, 0);

    // Use geo-search to find events within radius
    let availableEvents: any[] = [];
    
    try {
      const geoResult = await searchEventsWithinRadius(lat, lng, radius, {
        limit: 30,
        status: 'published',
        dateFrom: dayStart,
        dateTo: dayEnd,
      });
      
      // Fetch full event data with categories and scores
      if (geoResult.events.length > 0) {
        const eventIds = geoResult.events.map(e => e.id);
        availableEvents = await prisma.canonicalEvent.findMany({
          where: {
            id: { in: eventIds },
            is_complete: true,
            // Age filter
            OR: [
              { age_min: null, age_max: null }, // No age restriction
              {
                AND: [
                  { OR: [{ age_min: null }, { age_min: { lte: maxAge } }] },
                  { OR: [{ age_max: null }, { age_max: { gte: minAge } }] },
                ]
              }
            ]
          },
          include: {
            categories: { include: { category: true } },
            scores: true,
          },
        });
        
        // Add distance from geo search
        availableEvents = availableEvents.map(event => {
          const geoEvent = geoResult.events.find(e => e.id === event.id);
          return { ...event, distance_km: geoEvent?.distance_km };
        });
      }
    } catch (geoError) {
      logger.warn('Geo search failed, falling back to standard query', { error: geoError });
      
      // Fallback to standard query without geo
      const where: any = {
        status: 'published',
        is_complete: true,
        is_cancelled: false,
        start_datetime: { gte: dayStart, lte: dayEnd },
        OR: [
          { age_min: null, age_max: null },
          {
            AND: [
              { OR: [{ age_min: null }, { age_min: { lte: maxAge } }] },
              { OR: [{ age_max: null }, { age_max: { gte: minAge } }] },
            ]
          }
        ]
      };
      
      availableEvents = await prisma.canonicalEvent.findMany({
        where,
        include: {
          categories: { include: { category: true } },
          scores: true,
        },
        orderBy: [
          { scores: { family_fit_score: 'desc' } },
          { scores: { stressfree_score: 'desc' } },
        ],
        take: 30,
      });
    }

    // Apply budget filter
    if (budget <= 0) {
      availableEvents = availableEvents.filter(e => e.price_type === 'free');
    } else {
      availableEvents = availableEvents.filter(e => 
        e.price_type === 'free' || 
        (e.price_min && Number(e.price_min) <= budget / 2)
      );
    }

    // Apply preferences
    if (preferences.indoor === true && preferences.outdoor !== true) {
      availableEvents = availableEvents.filter(e => e.is_indoor);
    } else if (preferences.outdoor === true && preferences.indoor !== true) {
      availableEvents = availableEvents.filter(e => e.is_outdoor);
    }

    if (preferences.categories?.length > 0) {
      availableEvents = availableEvents.filter(e => 
        e.categories?.some((c: any) => preferences.categories.includes(c.category?.slug))
      );
    }

    // Sort by score and distance
    availableEvents.sort((a, b) => {
      const scoreA = (a.scores?.family_fit_score || 0) + (a.scores?.stressfree_score || 0);
      const scoreB = (b.scores?.family_fit_score || 0) + (b.scores?.stressfree_score || 0);
      const distanceA = a.distance_km || 100;
      const distanceB = b.distance_km || 100;
      
      // Weighted score: quality (60%) + proximity (40%)
      const weightedA = scoreA * 0.6 - distanceA * 4;
      const weightedB = scoreB * 0.6 - distanceB * 4;
      
      return weightedB - weightedA;
    });

    // Select events for the plan
    let selectedEvents: any[];
    let planBEvents: any[];
    let aiUsed = false;

    // Try AI-based selection if requested and available
    if (use_ai && AI_WORKER_URL) {
      try {
        const aiResponse = await fetch(`${AI_WORKER_URL}/plan/optimize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            events: availableEvents.map(e => ({
              id: e.id,
              title: e.title,
              description: e.description_short,
              start_datetime: e.start_datetime,
              end_datetime: e.end_datetime,
              location_address: e.location_address,
              location_lat: e.location_lat,
              location_lng: e.location_lng,
              price_type: e.price_type,
              price_min: e.price_min,
              is_indoor: e.is_indoor,
              is_outdoor: e.is_outdoor,
              categories: e.categories?.map((c: any) => c.category?.slug),
              scores: e.scores,
              distance_km: e.distance_km,
            })),
            children_ages,
            date: targetDate.toISOString(),
            budget,
            preferences,
            user_location: { lat, lng },
          }),
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });

        if (aiResponse.ok) {
          const aiResult = await aiResponse.json();
          if (aiResult.selected_events && aiResult.plan_b_events) {
            selectedEvents = aiResult.selected_events.map((id: string) => 
              availableEvents.find(e => e.id === id)
            ).filter(Boolean);
            planBEvents = aiResult.plan_b_events.map((id: string) => 
              availableEvents.find(e => e.id === id)
            ).filter(Boolean);
            aiUsed = true;
          }
        }
      } catch (aiError) {
        logger.warn('AI plan optimization failed, using fallback', { error: aiError });
      }
    }

    // Fallback to rule-based selection
    if (!aiUsed) {
      selectedEvents = selectEventsForPlan(availableEvents, {
        targetCount: 3,
        children_ages,
      });

      // Get Plan B (indoor alternatives)
      planBEvents = availableEvents
        .filter(e => e.is_indoor && !selectedEvents.includes(e))
        .slice(0, 3);
    }

    // Create time slots
    const slots = createTimeSlots(selectedEvents, targetDate);
    const planBSlots = createTimeSlots(planBEvents, targetDate);

    // Calculate total cost
    const estimatedCost = selectedEvents.reduce((sum, event) => {
      if (event.price_type === 'free') return sum;
      const price = Number(event.price_min) || 0;
      return sum + (price * (children_ages.length + 2)); // Assume 2 adults
    }, 0);

    // Calculate total distance
    const totalDistance = selectedEvents.reduce((sum, event) => {
      return sum + (event.distance_km || 0);
    }, 0);

    const plan = {
      date: targetDate.toISOString().split('T')[0],
      children_ages,
      budget,
      estimated_cost: Math.round(estimatedCost * 100) / 100,
      total_distance_km: Math.round(totalDistance * 10) / 10,
      main_plan: {
        slots,
        total_events: slots.filter(s => s.event_id).length,
      },
      plan_b: {
        reason: 'Bei Regen oder wenn ausgebucht',
        slots: planBSlots,
      },
      tips: generateTips(selectedEvents, children_ages),
      meta: {
        events_considered: availableEvents.length,
        ai_optimized: aiUsed,
        search_radius_km: radius,
      }
    };

    res.json({
      success: true,
      data: plan,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// SAVE & SHARE PLANS
// ============================================

// POST /api/plan/save - Save a generated plan
router.post('/save', optionalAuth, [
  body('date').isISO8601(),
  body('children_ages').isArray(),
  body('budget').optional().isFloat({ min: 0 }),
  body('title').optional().isString().isLength({ max: 200 }),
  body('slots').isArray(),
  body('plan_b_slots').optional().isArray(),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError('Validation error', 400, 'VALIDATION_ERROR');
    }

    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub || null;

    const {
      date,
      children_ages,
      budget,
      title,
      slots,
      plan_b_slots = [],
      preferences,
    } = req.body;

    // Create the plan
    const plan = await prisma.plan.create({
      data: {
        user_id: userId,
        title: title || `Kiezling-Tag am ${new Date(date).toLocaleDateString('de-DE')}`,
        date: new Date(date),
        children_ages,
        budget: budget || null,
        preferences: preferences || null,
      }
    });

    // Create main plan slots
    for (const slot of slots) {
      await prisma.planSlot.create({
        data: {
          plan_id: plan.id,
          event_id: slot.event_id || null,
          slot_type: slot.type === 'break' ? 'break' : 'activity',
          start_time: new Date(slot.start_time),
          end_time: new Date(slot.end_time),
          duration_minutes: slot.duration_minutes,
          notes: slot.notes || slot.suggestion || null,
        }
      });
    }

    // Create Plan B slots
    for (const slot of plan_b_slots) {
      await prisma.planSlot.create({
        data: {
          plan_id: plan.id,
          plan_b_for_id: plan.id,
          event_id: slot.event_id || null,
          slot_type: slot.type === 'break' ? 'break' : 'activity',
          start_time: new Date(slot.start_time),
          end_time: new Date(slot.end_time),
          duration_minutes: slot.duration_minutes,
          notes: slot.notes || null,
        }
      });
    }

    // Generate share URL
    const shareUrl = `/plan/${plan.id}`;

    res.status(201).json({
      success: true,
      message: 'Plan gespeichert',
      data: {
        id: plan.id,
        share_url: shareUrl,
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/plan/:id - Get saved plan
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const plan = await prisma.plan.findUnique({
      where: { id },
      include: {
        slots: {
          where: { plan_b_for_id: null },
          include: {
            event: {
              select: {
                id: true,
                title: true,
                description_short: true,
                location_address: true,
                price_type: true,
                price_min: true,
                is_indoor: true,
                is_outdoor: true,
              }
            }
          },
          orderBy: { start_time: 'asc' }
        },
        plan_b_slots: {
          include: {
            event: {
              select: {
                id: true,
                title: true,
                description_short: true,
                location_address: true,
                price_type: true,
                price_min: true,
                is_indoor: true,
                is_outdoor: true,
              }
            }
          },
          orderBy: { start_time: 'asc' }
        }
      }
    });

    if (!plan) {
      throw createError('Plan not found', 404, 'NOT_FOUND');
    }

    res.json({
      success: true,
      data: plan,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/plan/:id - Delete own plan
router.delete('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    const { id } = req.params;

    const plan = await prisma.plan.findUnique({
      where: { id }
    });

    if (!plan) {
      throw createError('Plan not found', 404, 'NOT_FOUND');
    }

    // Only owner can delete (admin check could be added)
    if (plan.user_id !== authReq.user!.sub) {
      throw createError('Not authorized', 403, 'FORBIDDEN');
    }

    await prisma.plan.delete({
      where: { id }
    });

    res.json({
      success: true,
      message: 'Plan deleted'
    });
  } catch (error) {
    next(error);
  }
});

// Helper functions

function selectEventsForPlan(events: any[], options: { targetCount: number; children_ages: number[] }) {
  const { targetCount } = options;
  
  if (events.length === 0) return [];
  if (events.length <= targetCount) return events;

  // Simple selection: take top events by score, ensuring variety
  const selected: any[] = [];
  const usedCategories = new Set<string>();

  for (const event of events) {
    if (selected.length >= targetCount) break;

    // Try to get variety in categories
    const eventCategories = event.categories?.map((c: any) => c.category?.slug) || [];
    const hasNewCategory = eventCategories.some((cat: string) => !usedCategories.has(cat));

    if (selected.length < 2 || hasNewCategory) {
      selected.push(event);
      eventCategories.forEach((cat: string) => usedCategories.add(cat));
    }
  }

  // Fill remaining slots if needed
  while (selected.length < targetCount && selected.length < events.length) {
    const remaining = events.filter(e => !selected.includes(e));
    if (remaining.length > 0) {
      selected.push(remaining[0]);
    } else {
      break;
    }
  }

  return selected;
}

function createTimeSlots(events: any[], date: Date) {
  const slots: any[] = [];
  let currentTime = new Date(date);
  currentTime.setHours(10, 0, 0, 0); // Start at 10 AM

  for (const event of events) {
    const startTime = new Date(currentTime);
    const duration = 90; // Default 90 minutes per activity
    const endTime = new Date(startTime.getTime() + duration * 60000);

    slots.push({
      event_id: event.id,
      event: {
        id: event.id,
        title: event.title,
        description_short: event.description_short,
        location_address: event.location_address,
        price_type: event.price_type,
        price_min: event.price_min,
        categories: event.categories,
        is_indoor: event.is_indoor,
        is_outdoor: event.is_outdoor,
      },
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      duration_minutes: duration,
    });

    // Add 30 min break between activities
    currentTime = new Date(endTime.getTime() + 30 * 60000);

    // Add lunch break after 2nd activity
    if (slots.length === 2) {
      slots.push({
        type: 'break',
        title: 'Mittagspause',
        start_time: currentTime.toISOString(),
        end_time: new Date(currentTime.getTime() + 60 * 60000).toISOString(),
        duration_minutes: 60,
        suggestion: 'Zeit für ein Mittagessen in der Nähe',
      });
      currentTime = new Date(currentTime.getTime() + 60 * 60000);
    }
  }

  return slots;
}

function generateTips(events: any[], childrenAges: number[]) {
  const tips: string[] = [];

  // General tips
  if (childrenAges.some(age => age < 3)) {
    tips.push('Denke an Wickeltasche und Snacks für die Kleinen');
  }

  if (events.some(e => e.is_outdoor)) {
    tips.push('Sonnencreme und Wasser nicht vergessen');
  }

  if (events.length > 2) {
    tips.push('Plant genug Pausen ein - Kinder brauchen Zeit zum Verarbeiten');
  }

  tips.push('Fahrt mit dem ÖPNV? Die KVV-App zeigt Live-Verbindungen');

  return tips;
}

export default router;
