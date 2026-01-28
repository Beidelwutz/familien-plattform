/**
 * Trending terms computation logic
 */

import { prisma } from '../prisma.js';

export interface TrendMetrics {
  term: string;
  searches24h: number;
  baseline7d: number;
  trendRatio: number;
  score: number;
}

export async function computeTrendingTerms(city: string | null): Promise<TrendMetrics[]> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Aggregate last 24h
  const current = await prisma.searchQueryLog.groupBy({
    by: ['queryNorm'],
    where: {
      city,
      createdAt: { gte: yesterday }
    },
    _count: true
  });

  // Aggregate last 7 days
  const historical = await prisma.searchQueryLog.groupBy({
    by: ['queryNorm'],
    where: {
      city,
      createdAt: { gte: sevenDaysAgo }
    },
    _count: true
  });

  // Compute metrics
  const metrics: TrendMetrics[] = current.map(c => {
    const hist = historical.find(h => h.queryNorm === c.queryNorm);
    const searches24h = c._count;
    const searches7d = hist?._count || 0;
    const baseline7d = searches7d / 7;
    const trendRatio = (searches24h + 1) / (baseline7d + 1);
    const score = searches24h * trendRatio;

    return {
      term: c.queryNorm,
      searches24h,
      baseline7d,
      trendRatio,
      score
    };
  });

  // Filter: Fire badge when trendRatio >= 2 && searches24h >= 10
  return metrics
    .filter(m => m.trendRatio >= 2 && m.searches24h >= 10)
    .sort((a, b) => b.score - a.score);
}
