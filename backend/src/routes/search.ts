/**
 * Public search API - suggestions and logging
 */

import { Router, Request, Response, NextFunction } from 'express';
import { query, body, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma.js';
import { normalizeQuery } from '../lib/trends/normalize.js';
import { mergeSuggestionsAndTrends } from '../lib/trends/merge.js';
import { getDefaultSuggestions, getSuggestionsByPrefix } from '../lib/trends/defaults.js';

const router = Router();
const CITY = 'karlsruhe';  // MVP hardcoded

// GET /api/search/suggestions?q=<prefix>&city=<city>
router.get('/suggestions', [
  query('q').optional().isString().isLength({ max: 120 }),
  query('city').optional().isString()
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const prefix = normalizeQuery((req.query.q as string) || '');
    const city = CITY;  // Ignore user input, use hardcoded

    // Get suggestions - different logic for empty vs prefix search
    const baseSuggestions = prefix === ''
      ? await getDefaultSuggestions(city)
      : await getSuggestionsByPrefix(prefix, city);

    // Get trending terms (latest computedAt)
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

    // Get active overrides
    const now = new Date();
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

    // Apply merge engine
    const result = mergeSuggestionsAndTrends(
      baseSuggestions,
      baseTrending,
      overrides,
      now
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/search/log
router.post('/log', [
  body('query').isString().notEmpty().isLength({ max: 120 }),
  body('city').optional().isString()
], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const queryNorm = normalizeQuery(req.body.query);
    const city = CITY;

    await prisma.searchQueryLog.create({
      data: { queryNorm, city }
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
