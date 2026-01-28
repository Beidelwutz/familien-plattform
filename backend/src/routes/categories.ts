/**
 * Category CRUD API
 * 
 * Features:
 * - Hierarchical categories with parent/children
 * - Sort order for drag & drop
 * - Cycle detection for parent changes
 * - Batch reorder endpoint
 * - Audit logging for all changes
 * - Slug immutability (once set)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { body, param, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { createError } from '../middleware/errorHandler.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { 
  logCategoryAction, 
  logBatchReorder, 
  computeChanges, 
  AuditAction 
} from '../lib/adminAudit.js';

const router = Router();

// ============================================
// MIDDLEWARE
// ============================================

/**
 * Require admin role
 */
const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const authReq = req as AuthRequest;
  if (authReq.user?.role !== 'admin') {
    return next(createError('Admin access required', 403, 'FORBIDDEN'));
  }
  next();
};

// Apply auth + admin to all routes
router.use(requireAuth);
router.use(requireAdmin);

// ============================================
// HELPERS
// ============================================

/**
 * Check if moving a category to a new parent would create a cycle
 */
async function wouldCreateCycle(
  categoryId: string,
  newParentId: string | null
): Promise<boolean> {
  if (!newParentId) return false;
  if (categoryId === newParentId) return true;

  // Walk up the tree from newParentId to check if we hit categoryId
  let currentId: string | null = newParentId;
  const visited = new Set<string>();

  while (currentId) {
    if (visited.has(currentId)) {
      // Already a cycle in the data (shouldn't happen)
      return true;
    }
    visited.add(currentId);

    if (currentId === categoryId) {
      return true; // Would create cycle
    }

    const parent = await prisma.category.findUnique({
      where: { id: currentId },
      select: { parent_id: true },
    });

    currentId = parent?.parent_id || null;
  }

  return false;
}

/**
 * Validate slug format
 */
function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * Build category tree from flat list
 */
function buildCategoryTree(categories: any[]): any[] {
  const map = new Map(categories.map(c => [c.id, { ...c, children: [] }]));
  const roots: any[] = [];

  for (const cat of map.values()) {
    if (cat.parent_id && map.has(cat.parent_id)) {
      map.get(cat.parent_id)!.children.push(cat);
    } else {
      roots.push(cat);
    }
  }

  // Sort by sort_order at each level
  const sortChildren = (items: any[]) => {
    items.sort((a, b) => a.sort_order - b.sort_order);
    items.forEach(item => sortChildren(item.children));
  };
  sortChildren(roots);

  return roots;
}

// ============================================
// ENDPOINTS
// ============================================

/**
 * GET /api/admin/categories
 * List all categories with hierarchy and event counts
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { flat } = req.query;

    const categories = await prisma.category.findMany({
      include: {
        _count: { select: { events: true } },
        updated_by: { select: { id: true, email: true } },
      },
      orderBy: [{ parent_id: 'asc' }, { sort_order: 'asc' }, { name_de: 'asc' }],
    });

    // Return flat list or tree structure
    const data = flat === 'true' 
      ? categories 
      : buildCategoryTree(categories);

    res.json({
      success: true,
      data,
      meta: { total: categories.length },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/categories/:id
 * Get single category with details
 */
router.get('/:id', [
  param('id').isUUID(),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const category = await prisma.category.findUnique({
      where: { id },
      include: {
        parent: { select: { id: true, name_de: true, slug: true } },
        children: { 
          select: { id: true, name_de: true, slug: true, sort_order: true },
          orderBy: { sort_order: 'asc' },
        },
        _count: { select: { events: true } },
        updated_by: { select: { id: true, email: true } },
      },
    });

    if (!category) {
      throw createError('Category not found', 404, 'NOT_FOUND');
    }

    res.json({ success: true, data: category });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/categories
 * Create new category
 */
router.post('/', [
  body('slug')
    .isString()
    .isLength({ min: 2, max: 50 })
    .custom(isValidSlug)
    .withMessage('Slug must be lowercase alphanumeric with hyphens'),
  body('name_de').isString().isLength({ min: 2, max: 100 }),
  body('icon').optional().isString().isLength({ max: 10 }),
  body('parent_id').optional({ nullable: true }).isUUID(),
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
    const { slug, name_de, icon, parent_id, sort_order = 0 } = req.body;

    // Check slug uniqueness
    const existing = await prisma.category.findUnique({ where: { slug } });
    if (existing) {
      throw createError('Slug already exists', 409, 'SLUG_CONFLICT');
    }

    // Validate parent exists
    if (parent_id) {
      const parent = await prisma.category.findUnique({ where: { id: parent_id } });
      if (!parent) {
        throw createError('Parent category not found', 404, 'PARENT_NOT_FOUND');
      }
    }

    const category = await prisma.category.create({
      data: {
        slug,
        name_de,
        icon: icon || null,
        parent_id: parent_id || null,
        sort_order,
        updated_by_id: authReq.user!.sub,
      },
    });

    // Audit log
    await logCategoryAction(authReq.user!.sub, AuditAction.CREATE, category, undefined, req);

    res.status(201).json({
      success: true,
      message: 'Category created',
      data: category,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/categories/:id
 * Update category (slug is immutable after creation)
 */
router.put('/:id', [
  param('id').isUUID(),
  body('name_de').optional().isString().isLength({ min: 2, max: 100 }),
  body('icon').optional({ nullable: true }).isString().isLength({ max: 10 }),
  body('parent_id').optional({ nullable: true }).isUUID(),
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
    const { name_de, icon, parent_id, sort_order } = req.body;

    const existing = await prisma.category.findUnique({ where: { id } });
    if (!existing) {
      throw createError('Category not found', 404, 'NOT_FOUND');
    }

    // Check for cycle if parent is changing
    if (parent_id !== undefined && parent_id !== existing.parent_id) {
      if (await wouldCreateCycle(id, parent_id)) {
        throw createError(
          'Cannot move category into its own subtree',
          422,
          'CYCLE_DETECTED'
        );
      }
    }

    // Build update data
    const updateData: any = {
      updated_by_id: authReq.user!.sub,
    };
    if (name_de !== undefined) updateData.name_de = name_de;
    if (icon !== undefined) updateData.icon = icon || null;
    if (parent_id !== undefined) updateData.parent_id = parent_id || null;
    if (sort_order !== undefined) updateData.sort_order = sort_order;

    // Compute changes for audit
    const changes = computeChanges(existing, { ...existing, ...updateData }, [
      'name_de', 'icon', 'parent_id', 'sort_order'
    ]);

    const category = await prisma.category.update({
      where: { id },
      data: updateData,
    });

    // Audit log
    await logCategoryAction(authReq.user!.sub, AuditAction.UPDATE, category, changes, req);

    res.json({
      success: true,
      message: 'Category updated',
      data: category,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/categories/:id
 * Delete category (only if no events and no children)
 */
router.delete('/:id', [
  param('id').isUUID(),
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    const { id } = req.params;

    const category = await prisma.category.findUnique({
      where: { id },
      include: {
        _count: { select: { events: true, children: true } },
      },
    });

    if (!category) {
      throw createError('Category not found', 404, 'NOT_FOUND');
    }

    // Check for events
    if (category._count.events > 0) {
      throw createError(
        `Cannot delete: ${category._count.events} events are assigned to this category`,
        409,
        'HAS_EVENTS'
      );
    }

    // Check for children
    if (category._count.children > 0) {
      throw createError(
        `Cannot delete: ${category._count.children} child categories exist`,
        409,
        'HAS_CHILDREN'
      );
    }

    await prisma.category.delete({ where: { id } });

    // Audit log
    await logCategoryAction(authReq.user!.sub, AuditAction.DELETE, category, undefined, req);

    res.json({
      success: true,
      message: 'Category deleted',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/admin/categories/reorder
 * Batch reorder categories (for drag & drop)
 * 
 * Body: { moves: [{ id, sort_order, parent_id? }] }
 */
router.patch('/reorder', [
  body('moves').isArray({ min: 1, max: 100 }),
  body('moves.*.id').isUUID(),
  body('moves.*.sort_order').isInt({ min: 0 }),
  body('moves.*.parent_id').optional({ nullable: true }).isUUID(),
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

    // Validate all categories exist and check for cycles
    for (const move of moves) {
      const existing = await prisma.category.findUnique({ where: { id: move.id } });
      if (!existing) {
        throw createError(`Category ${move.id} not found`, 404, 'NOT_FOUND');
      }

      if (move.parent_id !== undefined && move.parent_id !== existing.parent_id) {
        if (await wouldCreateCycle(move.id, move.parent_id)) {
          throw createError(
            `Moving ${move.id} to parent ${move.parent_id} would create a cycle`,
            422,
            'CYCLE_DETECTED'
          );
        }
      }
    }

    // Execute all moves in a transaction
    await prisma.$transaction(
      moves.map((move: any) => 
        prisma.category.update({
          where: { id: move.id },
          data: {
            sort_order: move.sort_order,
            ...(move.parent_id !== undefined && { parent_id: move.parent_id || null }),
            updated_by_id: authReq.user!.sub,
          },
        })
      )
    );

    // Audit log
    await logBatchReorder(authReq.user!.sub, 'category', moves, req);

    res.json({
      success: true,
      message: `${moves.length} categories reordered`,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
