/**
 * Amenity CRUD API
 * 
 * Features:
 * - Flat list of amenities (no hierarchy)
 * - Sort order for display
 * - Event confirmation workflow (is_confirmed)
 * - Audit logging for all changes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { 
  logAmenityAction, 
  logBatchReorder,
  logAdminAction,
  computeChanges, 
  AuditAction 
} from '../lib/adminAudit.js';

const router = Router();

// ============================================
// MIDDLEWARE
// ============================================

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const authReq = req as AuthRequest;
  if (authReq.user?.role !== 'admin') {
    return next(createError('Admin access required', 403, 'FORBIDDEN'));
  }
  next();
};

router.use(requireAuth);
router.use(requireAdmin);

// ============================================
// HELPERS
// ============================================

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

// ============================================
// AMENITY CRUD
// ============================================

/**
 * GET /api/admin/amenities
 * List all amenities with event counts
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const amenities = await prisma.amenity.findMany({
      include: {
        _count: { 
          select: { 
            events: true,
          } 
        },
        updated_by: { select: { id: true, email: true } },
      },
      orderBy: [{ sort_order: 'asc' }, { name_de: 'asc' }],
    });

    // Also get unconfirmed count per amenity
    const unconfirmedCounts = await prisma.eventAmenity.groupBy({
      by: ['amenity_id'],
      where: { is_confirmed: false },
      _count: { amenity_id: true },
    });

    const unconfirmedMap = new Map(
      unconfirmedCounts.map(u => [u.amenity_id, u._count.amenity_id])
    );

    const data = amenities.map(a => ({
      ...a,
      unconfirmed_count: unconfirmedMap.get(a.id) || 0,
    }));

    res.json({
      success: true,
      data,
      meta: { total: amenities.length },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/amenities/:id
 * Get single amenity with details
 */
router.get('/:id', [
  param('id').isUUID(),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const amenity = await prisma.amenity.findUnique({
      where: { id },
      include: {
        _count: { select: { events: true } },
        updated_by: { select: { id: true, email: true } },
      },
    });

    if (!amenity) {
      throw createError('Amenity not found', 404, 'NOT_FOUND');
    }

    // Get unconfirmed count
    const unconfirmedCount = await prisma.eventAmenity.count({
      where: { amenity_id: id, is_confirmed: false },
    });

    res.json({ 
      success: true, 
      data: { ...amenity, unconfirmed_count: unconfirmedCount },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/amenities
 * Create new amenity
 */
router.post('/', [
  body('slug')
    .isString()
    .isLength({ min: 2, max: 50 })
    .custom(isValidSlug)
    .withMessage('Slug must be lowercase alphanumeric with hyphens'),
  body('name_de').isString().isLength({ min: 2, max: 100 }),
  body('icon').optional().isString().isLength({ max: 10 }),
  body('sort_order').optional().isInt({ min: 0 }),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError(
        'Validation error: ' + errors.array().map(e => e.msg).join(', '),
        422,
        'VALIDATION_ERROR'
      );
    }

    const authReq = req as AuthRequest;
    const { slug, name_de, icon, sort_order = 0 } = req.body;

    // Check slug uniqueness
    const existing = await prisma.amenity.findUnique({ where: { slug } });
    if (existing) {
      throw createError('Slug already exists', 409, 'SLUG_CONFLICT');
    }

    const amenity = await prisma.amenity.create({
      data: {
        slug,
        name_de,
        icon: icon || null,
        sort_order,
        updated_by_id: authReq.user!.sub,
      },
    });

    await logAmenityAction(authReq.user!.sub, AuditAction.CREATE, amenity, undefined, req);

    res.status(201).json({
      success: true,
      message: 'Amenity created',
      data: amenity,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/amenities/:id
 * Update amenity
 */
router.put('/:id', [
  param('id').isUUID(),
  body('name_de').optional().isString().isLength({ min: 2, max: 100 }),
  body('icon').optional({ nullable: true }).isString().isLength({ max: 10 }),
  body('sort_order').optional().isInt({ min: 0 }),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError(
        'Validation error: ' + errors.array().map(e => e.msg).join(', '),
        422,
        'VALIDATION_ERROR'
      );
    }

    const authReq = req as AuthRequest;
    const { id } = req.params;
    const { name_de, icon, sort_order } = req.body;

    const existing = await prisma.amenity.findUnique({ where: { id } });
    if (!existing) {
      throw createError('Amenity not found', 404, 'NOT_FOUND');
    }

    const updateData: any = {
      updated_by_id: authReq.user!.sub,
    };
    if (name_de !== undefined) updateData.name_de = name_de;
    if (icon !== undefined) updateData.icon = icon || null;
    if (sort_order !== undefined) updateData.sort_order = sort_order;

    const changes = computeChanges(existing, { ...existing, ...updateData }, [
      'name_de', 'icon', 'sort_order'
    ]);

    const amenity = await prisma.amenity.update({
      where: { id },
      data: updateData,
    });

    await logAmenityAction(authReq.user!.sub, AuditAction.UPDATE, amenity, changes, req);

    res.json({
      success: true,
      message: 'Amenity updated',
      data: amenity,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/amenities/:id
 * Delete amenity (only if no events)
 */
router.delete('/:id', [
  param('id').isUUID(),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    const { id } = req.params;

    const amenity = await prisma.amenity.findUnique({
      where: { id },
      include: { _count: { select: { events: true } } },
    });

    if (!amenity) {
      throw createError('Amenity not found', 404, 'NOT_FOUND');
    }

    if (amenity._count.events > 0) {
      throw createError(
        `Cannot delete: ${amenity._count.events} events have this amenity`,
        409,
        'HAS_EVENTS'
      );
    }

    await prisma.amenity.delete({ where: { id } });
    await logAmenityAction(authReq.user!.sub, AuditAction.DELETE, amenity, undefined, req);

    res.json({ success: true, message: 'Amenity deleted' });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/admin/amenities/reorder
 * Batch reorder amenities
 */
router.patch('/reorder', [
  body('moves').isArray({ min: 1, max: 100 }),
  body('moves.*.id').isUUID(),
  body('moves.*.sort_order').isInt({ min: 0 }),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw createError(
        'Validation error: ' + errors.array().map(e => e.msg).join(', '),
        422,
        'VALIDATION_ERROR'
      );
    }

    const authReq = req as AuthRequest;
    const { moves } = req.body;

    await prisma.$transaction(
      moves.map((move: any) =>
        prisma.amenity.update({
          where: { id: move.id },
          data: {
            sort_order: move.sort_order,
            updated_by_id: authReq.user!.sub,
          },
        })
      )
    );

    await logBatchReorder(authReq.user!.sub, 'amenity', moves, req);

    res.json({
      success: true,
      message: `${moves.length} amenities reordered`,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// EVENT AMENITY CONFIRMATION
// ============================================

/**
 * GET /api/admin/amenities/unconfirmed
 * List unconfirmed event-amenity assignments
 */
router.get('/events/unconfirmed', [
  query('amenity_id').optional().isUUID(),
  query('event_id').optional().isUUID(),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('offset').optional().isInt({ min: 0 }),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { amenity_id, event_id, limit = 50, offset = 0 } = req.query;

    const where: any = { is_confirmed: false };
    if (amenity_id) where.amenity_id = amenity_id;
    if (event_id) where.event_id = event_id;

    const [items, total] = await Promise.all([
      prisma.eventAmenity.findMany({
        where,
        include: {
          event: { select: { id: true, title: true } },
          amenity: { select: { id: true, name_de: true, icon: true } },
        },
        take: Number(limit),
        skip: Number(offset),
        orderBy: { event: { created_at: 'desc' } },
      }),
      prisma.eventAmenity.count({ where }),
    ]);

    res.json({
      success: true,
      data: items,
      meta: { total, limit: Number(limit), offset: Number(offset) },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/events/:eventId/amenities/:amenityId/confirm
 * Confirm a single event-amenity assignment
 */
router.post('/events/:eventId/amenities/:amenityId/confirm', [
  param('eventId').isUUID(),
  param('amenityId').isUUID(),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    const { eventId, amenityId } = req.params;

    const eventAmenity = await prisma.eventAmenity.findUnique({
      where: { event_id_amenity_id: { event_id: eventId, amenity_id: amenityId } },
      include: {
        event: { select: { title: true } },
        amenity: { select: { name_de: true } },
      },
    });

    if (!eventAmenity) {
      throw createError('Event-Amenity assignment not found', 404, 'NOT_FOUND');
    }

    if (eventAmenity.is_confirmed) {
      return res.json({ success: true, message: 'Already confirmed' });
    }

    await prisma.eventAmenity.update({
      where: { event_id_amenity_id: { event_id: eventId, amenity_id: amenityId } },
      data: { is_confirmed: true },
    });

    await logAdminAction({
      userId: authReq.user!.sub,
      action: AuditAction.CONFIRM,
      entityType: 'event_amenity',
      entityId: `${eventId}:${amenityId}`,
      entityName: `${eventAmenity.event.title} - ${eventAmenity.amenity.name_de}`,
      req,
    });

    res.json({ success: true, message: 'Amenity confirmed' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/events/:eventId/amenities/confirm-all
 * Confirm all amenities for an event
 */
router.post('/events/:eventId/amenities/confirm-all', [
  param('eventId').isUUID(),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    const { eventId } = req.params;

    const result = await prisma.eventAmenity.updateMany({
      where: { event_id: eventId, is_confirmed: false },
      data: { is_confirmed: true },
    });

    if (result.count > 0) {
      await logAdminAction({
        userId: authReq.user!.sub,
        action: AuditAction.CONFIRM,
        entityType: 'event_amenity',
        entityId: eventId,
        entityName: `Batch confirm for event`,
        metadata: { confirmed_count: result.count },
        req,
      });
    }

    res.json({
      success: true,
      message: `${result.count} amenities confirmed`,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/events/:eventId/amenities/:amenityId
 * Remove an amenity from an event
 */
router.delete('/events/:eventId/amenities/:amenityId', [
  param('eventId').isUUID(),
  param('amenityId').isUUID(),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    const { eventId, amenityId } = req.params;

    const eventAmenity = await prisma.eventAmenity.findUnique({
      where: { event_id_amenity_id: { event_id: eventId, amenity_id: amenityId } },
      include: {
        event: { select: { title: true } },
        amenity: { select: { name_de: true } },
      },
    });

    if (!eventAmenity) {
      throw createError('Event-Amenity assignment not found', 404, 'NOT_FOUND');
    }

    await prisma.eventAmenity.delete({
      where: { event_id_amenity_id: { event_id: eventId, amenity_id: amenityId } },
    });

    await logAdminAction({
      userId: authReq.user!.sub,
      action: AuditAction.DELETE,
      entityType: 'event_amenity',
      entityId: `${eventId}:${amenityId}`,
      entityName: `${eventAmenity.event.title} - ${eventAmenity.amenity.name_de}`,
      req,
    });

    res.json({ success: true, message: 'Amenity removed from event' });
  } catch (error) {
    next(error);
  }
});

export default router;
