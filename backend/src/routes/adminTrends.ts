/**
 * Admin trends API - compute, preview, overrides CRUD
 */

import { Router, Request, Response, NextFunction } from 'express';
import { body, query, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { computeTrendingTerms } from '../lib/trends/compute.js';
import { mergeSuggestionsAndTrends } from '../lib/trends/merge.js';
import { normalizeQuery } from '../lib/trends/normalize.js';
import { getDefaultSuggestions, getSuggestionsByPrefix } from '../lib/trends/defaults.js';

const router = Router();
const CITY = 'karlsruhe';

router.use(requireAuth, requireAdmin);

// POST /api/admin/trends/compute - Triggered by external cron
router.post('/compute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Optional: Check for CRON_SECRET
    const cronSecret = req.headers['x-cron-secret'];
    if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const metrics = await computeTrendingTerms(CITY);
    const now = new Date();

    // Insert new trending terms
    if (metrics.length > 0) {
      await prisma.trendingTerm.createMany({
        data: metrics.map(m => ({
          term: m.term,
          city: CITY,
          score: m.score,
          trendRatio: m.trendRatio,
          searches24h: m.searches24h,
          baseline7d: m.baseline7d,
          computedAt: now
        }))
      });
    }

    res.json({ 
      success: true, 
      computed: metrics.length,
      timestamp: now
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/trends/preview?q=<prefix>&applyOverrides=true
router.get('/preview', [
  query('q').optional().isString(),
  query('applyOverrides').optional().isString()
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prefix = normalizeQuery((req.query.q as string) || '');
    const city = CITY;
    const applyOverrides = req.query.applyOverrides !== 'false';
    const isDefaultView = prefix === '';

    // Get suggestions - different logic for empty vs prefix search
    const baseSuggestions = isDefaultView
      ? await getDefaultSuggestions(city)
      : await getSuggestionsByPrefix(prefix, city);

    // Get trending terms
    const latestCompute = await prisma.trendingTerm.findFirst({
      where: { city },
      orderBy: { computedAt: 'desc' },
      select: { computedAt: true }
    });

    const baseTrending = latestCompute 
      ? await prisma.trendingTerm.findMany({
          where: { 
            city,
            computedAt: latestCompute.computedAt
          },
          orderBy: { score: 'desc' },
          take: 10,
          select: { term: true, score: true, trendRatio: true }
        }).then(terms => terms.map(t => ({
          text: t.term,
          badge: t.trendRatio >= 2 ? '🔥' : undefined,
          score: t.score,
          source: 'log' as const
        })))
      : [];

    const now = new Date();
    
    // Get overrides (even if not applying, we need the count)
    const overrides = await prisma.trendOverride.findMany({
      where: {
        OR: [{ city }, { city: null }],
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }
        ]
      }
    });

    // Apply merge engine only if applyOverrides is true
    const result = applyOverrides
      ? mergeSuggestionsAndTrends(baseSuggestions, baseTrending, overrides, now)
      : { suggestions: baseSuggestions.slice(0, 8), trending: baseTrending.slice(0, 6) };
    
    res.json({
      preview: result,
      debug: {
        baseSuggestionsCount: baseSuggestions.length,
        baseTrendingCount: baseTrending.length,
        overridesApplied: applyOverrides ? overrides.length : 0,
        isDefaultView
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/trends/overrides
router.get('/overrides', [
  query('city').optional().isString()
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const overrides = await prisma.trendOverride.findMany({
      where: {
        OR: [{ city: CITY }, { city: null }]
      },
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'desc' }
      ]
    });

    res.json({ data: overrides });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/trends/overrides
router.post('/overrides', [
  body('term').isString().notEmpty().isLength({ max: 120 }),
  body('action').isIn(['PIN', 'BOOST', 'HIDE', 'REPLACE', 'PUSH']),
  body('boost').optional().isInt({ min: 1, max: 100 }),
  body('replacement').optional().isString().isLength({ max: 120 }),
  body('label').optional().isString().isLength({ max: 50 }),
  body('startsAt').optional().isISO8601(),
  body('endsAt').optional().isISO8601(),
  body('priority').optional().isInt()
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Validation: REPLACE requires replacement
    if (req.body.action === 'REPLACE' && !req.body.replacement) {
      return res.status(400).json({ error: 'replacement required for REPLACE action' });
    }

    // Normalize the term
    const termNorm = normalizeQuery(req.body.term);

    // Check for existing active override with same termNorm, city, and action
    const existing = await prisma.trendOverride.findFirst({
      where: {
        termNorm,
        city: CITY,
        action: req.body.action,
        isActive: true
      }
    });

    if (existing) {
      return res.status(409).json({
        error: 'Override existiert bereits',
        message: `Ein aktiver ${req.body.action} Override für "${req.body.term}" existiert bereits.`,
        existingId: existing.id
      });
    }

    const override = await prisma.trendOverride.create({
      data: {
        term: req.body.term,
        termNorm,
        city: CITY,
        action: req.body.action,
        boost: req.body.boost,
        replacement: req.body.replacement,
        label: req.body.label,
        startsAt: req.body.startsAt ? new Date(req.body.startsAt) : null,
        endsAt: req.body.endsAt ? new Date(req.body.endsAt) : null,
        priority: req.body.priority || 0,
        createdById: (req as AuthRequest).user?.sub
      }
    });

    res.json({ success: true, data: override });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admin/trends/overrides/:id
router.patch('/overrides/:id', [
  body('term').optional().isString().isLength({ max: 120 }),
  body('action').optional().isIn(['PIN', 'BOOST', 'HIDE', 'REPLACE', 'PUSH']),
  body('boost').optional().isInt({ min: 1, max: 100 }),
  body('replacement').optional().isString().isLength({ max: 120 }),
  body('label').optional().isString().isLength({ max: 50 }),
  body('startsAt').optional().isISO8601(),
  body('endsAt').optional().isISO8601(),
  body('priority').optional().isInt(),
  body('isActive').optional().isBoolean()
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const updateData: any = { ...req.body };
    if (req.body.startsAt) updateData.startsAt = new Date(req.body.startsAt);
    if (req.body.endsAt) updateData.endsAt = new Date(req.body.endsAt);
    
    // If term is being updated, also update termNorm
    if (req.body.term) {
      updateData.termNorm = normalizeQuery(req.body.term);
    }

    const override = await prisma.trendOverride.update({
      where: { id: req.params.id },
      data: updateData
    });

    res.json({ success: true, data: override });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/admin/trends/overrides/:id
// Query param ?hard=true for permanent delete (for undo), otherwise soft delete
router.delete('/overrides/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hardDelete = req.query.hard === 'true';
    
    if (hardDelete) {
      await prisma.trendOverride.delete({
        where: { id: req.params.id }
      });
    } else {
      await prisma.trendOverride.update({
        where: { id: req.params.id },
        data: { isActive: false }
      });
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/trends/stats
router.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [totalSearches, uniqueTermsResult, activeOverrides, latestCompute] = await Promise.all([
      prisma.searchQueryLog.count({ where: { city: CITY } }),
      prisma.searchQueryLog.groupBy({
        by: ['queryNorm'],
        where: { city: CITY }
      }),
      prisma.trendOverride.count({ 
        where: { 
          city: CITY, 
          isActive: true 
        } 
      }),
      prisma.trendingTerm.findFirst({
        where: { city: CITY },
        orderBy: { computedAt: 'desc' },
        select: { computedAt: true }
      })
    ]);

    res.json({
      totalSearches,
      uniqueTerms: uniqueTermsResult.length,
      activeOverrides,
      lastComputed: latestCompute?.computedAt
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/trends/terms - Get computed trending terms
router.get('/terms', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const latestCompute = await prisma.trendingTerm.findFirst({
      where: { city: CITY },
      orderBy: { computedAt: 'desc' },
      select: { computedAt: true }
    });

    const terms = latestCompute
      ? await prisma.trendingTerm.findMany({
          where: {
            city: CITY,
            computedAt: latestCompute.computedAt
          },
          orderBy: { score: 'desc' }
        })
      : [];

    res.json({ data: terms });
  } catch (error) {
    next(error);
  }
});

export default router;
