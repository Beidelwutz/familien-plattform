import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';

const router = Router();
const HOMEPAGE_TEASER_KEY = 'homepage_teaser';
const HOMEPAGE_TEASER_DEFAULTS = {
  authorName: 'WENKE',
  message: "Heute Abend gibt's ein kleines Geheimkonzert – schau in die Tagestipps!",
  avatarSrc: 'https://i.pravatar.cc/96?u=wenke',
  countdownEndDate: '2025-08-16T20:00:00',
  variant: 7,
  contentVariant: 16,
  teaserLabel: 'Tipp von',
  teaserIcon: '',
  teaserThemeClass: '',
};

// GET /api/settings/homepage-teaser - Öffentlich, für Startseite
router.get('/homepage-teaser', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key: HOMEPAGE_TEASER_KEY } });
    const value = (row?.value as Record<string, unknown>) || {};
    const data = { ...HOMEPAGE_TEASER_DEFAULTS, ...value };
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

export default router;
