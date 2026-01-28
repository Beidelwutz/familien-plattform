/**
 * Type definitions for search suggestions and trending
 */

// Source of a suggestion/trending item
export type SuggestionSource = 
  | 'log'             // From SearchQueryLog
  | 'entity'          // Static categories/locations
  | 'event'           // From Event data
  | 'override_pin'    // Admin PIN override
  | 'override_push'   // Admin PUSH override
  | 'override_replace' // Replaced by override
  | 'override_boost'; // Boosted by override

export interface Suggestion {
  text: string;
  type: 'query' | 'entity' | 'event';
  score: number;
  source: SuggestionSource;
  originTerm?: string;  // For REPLACE: original term
  cityScope?: 'city' | 'global';
  overrideId?: string;  // If from override, the override ID
}

export interface TrendingItem {
  text: string;
  badge?: string;
  score: number;
  source: SuggestionSource;
  originTerm?: string;
  overrideId?: string;
}

export interface PreviewResult {
  suggestions: Suggestion[];
  trending: TrendingItem[];
}

export interface PreviewDebug {
  baseSuggestionsCount: number;
  baseTrendingCount: number;
  overridesApplied: number;
  isDefaultView: boolean;
}
