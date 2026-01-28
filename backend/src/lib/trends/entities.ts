/**
 * Static entities for fallback suggestions
 */

import { normalizeQuery } from './normalize.js';
import type { Suggestion } from './types.js';

export const STATIC_ENTITIES = {
  locations: [
    'Karlsruhe',
    'Durlach',
    'Ettlingen',
    'Bruchsal',
    'Karlsruhe Innenstadt',
    'Karlsruhe West',
    'Karlsruhe Ost',
    'Karlsruhe Süd',
    'Karlsruhe Nord'
  ],
  categories: [
    'Indoor',
    'Outdoor',
    'Museum',
    'Kindergeburtstag',
    'Flohmarkt',
    'Spielplatz',
    'Workshop',
    'Sport',
    'Musik',
    'Theater',
    'Kino',
    'Schwimmbad',
    'Zoo',
    'Park',
    'Bibliothek'
  ]
};

export function getEntitySuggestions(prefix: string): Suggestion[] {
  const norm = normalizeQuery(prefix);
  
  if (!norm) {
    // Return popular entities if no prefix
    return [
      ...STATIC_ENTITIES.locations.slice(0, 3),
      ...STATIC_ENTITIES.categories.slice(0, 3)
    ].map(e => ({ 
      text: e, 
      type: 'entity' as const, 
      score: 0.5,
      source: 'entity' as const,
      cityScope: 'global' as const
    }));
  }
  
  const all = [...STATIC_ENTITIES.locations, ...STATIC_ENTITIES.categories];
  
  return all
    .filter(e => normalizeQuery(e).startsWith(norm))
    .map(e => ({ 
      text: e, 
      type: 'entity' as const, 
      score: 0.5,
      source: 'entity' as const,
      cityScope: 'global' as const
    }));
}
