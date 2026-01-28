/**
 * Default suggestions logic for empty search field
 * Returns top categories + popular recent searches
 */

import { prisma } from '../prisma.js';
import type { Suggestion } from './types.js';

// Top categories to show in default view
const DEFAULT_CATEGORIES: Array<{ text: string; icon?: string }> = [
  { text: 'Indoor', icon: '🏠' },
  { text: 'Outdoor', icon: '🌳' },
  { text: 'Museum', icon: '🏛️' },
  { text: 'Spielplatz', icon: '🎠' },
  { text: 'Kindergeburtstag', icon: '🎂' },
  { text: 'Workshop', icon: '🎨' },
];

/**
 * Get default suggestions when search field is empty
 * Combines:
 * 1. Top categories (static)
 * 2. Popular searches from last 7 days
 */
export async function getDefaultSuggestions(city: string): Promise<Suggestion[]> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  // 1. Popular searches from logs (last 7 days)
  const popularSearches: Array<{ queryNorm: string; _count: number }> = await prisma.$queryRaw`
    SELECT "queryNorm", COUNT(*)::int as "_count"
    FROM search_query_logs
    WHERE city = ${city}
      AND "createdAt" >= ${sevenDaysAgo}
    GROUP BY "queryNorm"
    ORDER BY "_count" DESC
    LIMIT 4
  `;
  
  const suggestions: Suggestion[] = [];
  
  // 2. Add top categories first
  for (const cat of DEFAULT_CATEGORIES.slice(0, 4)) {
    suggestions.push({
      text: cat.text,
      type: 'entity',
      score: 100, // High score for categories
      source: 'entity',
      cityScope: 'global'
    });
  }
  
  // 3. Add popular searches
  for (const search of popularSearches) {
    // Avoid duplicates with categories
    const exists = suggestions.some(s => 
      s.text.toLowerCase() === search.queryNorm.toLowerCase()
    );
    if (!exists) {
      suggestions.push({
        text: search.queryNorm,
        type: 'query',
        score: search._count,
        source: 'log',
        cityScope: 'city'
      });
    }
  }
  
  return suggestions;
}

/**
 * Get suggestions by prefix search
 * Combines logs and entity matches
 */
export async function getSuggestionsByPrefix(
  prefix: string, 
  city: string
): Promise<Suggestion[]> {
  // Get from logs
  const logSuggestions: any[] = await prisma.$queryRaw`
    SELECT "queryNorm" as text, COUNT(*)::int as count
    FROM search_query_logs
    WHERE city = ${city}
      AND "queryNorm" LIKE ${prefix + '%'}
    GROUP BY "queryNorm"
    ORDER BY count DESC
    LIMIT 10
  `;
  
  // Get from static entities
  const { getEntitySuggestions } = await import('./entities.js');
  const entitySuggestions = getEntitySuggestions(prefix);
  
  // Combine and sort
  const suggestions: Suggestion[] = [
    ...logSuggestions.map((s: any) => ({
      text: s.text,
      type: 'query' as const,
      score: Number(s.count),
      source: 'log' as const,
      cityScope: 'city' as const
    })),
    ...entitySuggestions.map(e => ({
      ...e,
      source: 'entity' as const,
      cityScope: 'global' as const
    }))
  ];
  
  return suggestions.sort((a, b) => b.score - a.score);
}
