/**
 * Override merge engine for suggestions and trending terms
 */

import type { TrendOverride, TrendAction } from '@prisma/client';
import { normalizeQuery } from './normalize.js';
import type { Suggestion, TrendingItem, SuggestionSource } from './types.js';

// Re-export types for convenience
export type { Suggestion, TrendingItem, SuggestionSource };

export function mergeSuggestionsAndTrends(
  baseSuggestions: Suggestion[],
  baseTrending: TrendingItem[],
  overrides: TrendOverride[],
  now: Date
): { suggestions: Suggestion[], trending: TrendingItem[] } {
  
  // Filter active overrides
  const activeOverrides = overrides.filter(o => 
    o.isActive &&
    (!o.startsAt || o.startsAt <= now) &&
    (!o.endsAt || o.endsAt >= now)
  ).sort((a, b) => b.priority - a.priority);

  // Ensure all base items have source
  let suggestions: Suggestion[] = baseSuggestions.map(s => ({
    ...s,
    source: s.source || 'log'
  }));
  
  let trending: TrendingItem[] = baseTrending.map(t => ({
    ...t,
    source: t.source || 'log'
  }));

  // Apply overrides in order
  for (const override of activeOverrides) {
    const termNorm = normalizeQuery(override.term);

    switch (override.action) {
      case 'HIDE':
        suggestions = suggestions.filter(s => normalizeQuery(s.text) !== termNorm);
        trending = trending.filter(t => normalizeQuery(t.text) !== termNorm);
        break;

      case 'REPLACE':
        if (override.replacement) {
          suggestions = suggestions.map(s => 
            normalizeQuery(s.text) === termNorm 
              ? { 
                  ...s, 
                  text: override.replacement!, 
                  originTerm: s.text,
                  source: 'override_replace' as SuggestionSource,
                  overrideId: override.id
                }
              : s
          );
          trending = trending.map(t => 
            normalizeQuery(t.text) === termNorm 
              ? { 
                  ...t, 
                  text: override.replacement!,
                  originTerm: t.text,
                  source: 'override_replace' as SuggestionSource,
                  overrideId: override.id
                }
              : t
          );
        }
        break;

      case 'PUSH':
        // Add to trending if not present
        if (!trending.some(t => normalizeQuery(t.text) === termNorm)) {
          trending.push({
            text: override.term,
            badge: override.label || '🔥',
            score: 999 + override.priority,
            source: 'override_push',
            overrideId: override.id
          });
        }
        break;

      case 'PIN':
        // Remove from current position and add to top
        trending = trending.filter(t => normalizeQuery(t.text) !== termNorm);
        trending.unshift({
          text: override.term,
          badge: override.label || '📌',
          score: 9999 + override.priority,
          source: 'override_pin',
          overrideId: override.id
        });
        break;

      case 'BOOST':
        trending = trending.map(t => 
          normalizeQuery(t.text) === termNorm
            ? { 
                ...t, 
                score: t.score + (override.boost || 0),
                source: 'override_boost' as SuggestionSource,
                overrideId: override.id
              }
            : t
        );
        break;
    }
  }

  // Dedupe and resort
  suggestions = dedupeByText(suggestions).slice(0, 8);
  trending = dedupeByText(trending)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  return { suggestions, trending };
}

function dedupeByText<T extends { text: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const norm = normalizeQuery(item.text);
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
}
