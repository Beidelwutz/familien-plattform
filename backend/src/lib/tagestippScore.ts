/**
 * Tagestipp ranking: score components, re-ranking, and badge assignment.
 * PersonalMatchScore is derived from EventScore (AI); other components from event fields.
 */

export type TagestippBadge =
  | 'TRENDING'
  | 'GEHEIMTIPP'
  | 'LAST_CHANCE'
  | 'BUDGET_PICK'
  | 'WEATHER_SAFE'
  | 'MATCH';

export interface ScoreComponents {
  popularity: number;
  match: number;
  freshness: number;
  distance: number;
  total: number;
}

export interface EventWithScores {
  event: any;
  scoreComponents: ScoreComponents;
  totalScore: number;
}

const PERSONAL_MATCH_WEIGHTS = {
  family_fit_score: 0.3,
  stressfree_score: 0.25,
  relevance_score: 0.25,
  quality_score: 0.1,
  fun_score: 0.1,
};

const FALLBACK_MATCH = 0.5;

/**
 * PersonalMatchScore from EventScore (AI). 0-1.
 */
export function computePersonalMatchScore(event: any): number {
  const s = event.scores;
  if (!s) return FALLBACK_MATCH;
  const family = (s.family_fit_score ?? 0) / 100;
  const stressfree = (s.stressfree_score ?? 0) / 100;
  const relevance = (s.relevance_score ?? 0) / 100;
  const quality = (s.quality_score ?? 0) / 100;
  const fun = (s.fun_score ?? 50) / 100;
  return (
    family * PERSONAL_MATCH_WEIGHTS.family_fit_score +
    stressfree * PERSONAL_MATCH_WEIGHTS.stressfree_score +
    relevance * PERSONAL_MATCH_WEIGHTS.relevance_score +
    quality * PERSONAL_MATCH_WEIGHTS.quality_score +
    fun * PERSONAL_MATCH_WEIGHTS.fun_score
  );
}

/**
 * Popularity from view_count, save_count. Normalized ~0-1.
 */
export function computePopularityScore(event: any): number {
  const save = Number(event.save_count ?? 0);
  const view = Number(event.view_count ?? 0);
  const raw = save * 5 + view + 1;
  return Math.min(1, Math.log10(raw + 1) / 3);
}

/**
 * Freshness from created_at. Newer = higher, normalized ~0-1.
 */
export function computeFreshnessScore(event: any): number {
  const created = event.created_at ? new Date(event.created_at).getTime() : 0;
  const now = Date.now();
  const daysSince = (now - created) / (24 * 60 * 60 * 1000);
  if (daysSince <= 0) return 1;
  if (daysSince >= 30) return 0.2;
  return 1 - daysSince / 40;
}

/**
 * Distance score when user has lat/lng. Closer = higher. 0-1.
 */
export function computeDistanceScore(event: any): number {
  const km = event.distance_km;
  if (km == null) return 0.5;
  if (km <= 2) return 1;
  if (km <= 5) return 0.85;
  if (km <= 10) return 0.7;
  if (km <= 20) return 0.5;
  return Math.max(0.2, 0.5 - (km - 20) / 100);
}

/**
 * Default weights for total score (MVP, no intent).
 */
const DEFAULT_WEIGHTS = {
  popularity: 0.2,
  match: 0.4,
  freshness: 0.15,
  distance: 0.25,
};

export function computeTotalScore(
  event: any,
  weights: Partial<typeof DEFAULT_WEIGHTS> = {}
): { components: ScoreComponents; total: number } {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const popularity = computePopularityScore(event);
  const match = computePersonalMatchScore(event);
  const freshness = computeFreshnessScore(event);
  const distance = computeDistanceScore(event);
  const total =
    popularity * w.popularity + match * w.match + freshness * w.freshness + distance * w.distance;
  return {
    components: { popularity, match, freshness, distance, total },
    total,
  };
}

/**
 * Assign 2-3 badges per event. Priority order and rules.
 */
export function assignBadges(event: any, allCandidates: any[]): TagestippBadge[] {
  const badges: TagestippBadge[] = [];
  const s = event.scores;
  const match = computePersonalMatchScore(event);
  const popularity = computePopularityScore(event);
  const saveCount = Number(event.save_count ?? 0);
  const viewCount = Number(event.view_count ?? 0);
  const startDatetime = event.start_datetime ? new Date(event.start_datetime) : null;
  const now = new Date();
  const priceMin = event.price_min != null ? Number(event.price_min) : null;
  const priceType = event.price_type;

  // LAST_CHANCE: starts within 2 hours
  if (startDatetime) {
    const hoursUntil = (startDatetime.getTime() - now.getTime()) / (60 * 60 * 1000);
    if (hoursUntil >= 0 && hoursUntil < 2) badges.push('LAST_CHANCE');
  }

  // BUDGET_PICK: free or low cost
  if (priceType === 'free' || (priceMin != null && priceMin <= 5)) {
    badges.push('BUDGET_PICK');
  }

  // WEATHER_SAFE: indoor
  if (event.is_indoor === true) badges.push('WEATHER_SAFE');

  // TRENDING: high engagement relative to others
  const maxSave = Math.max(1, ...allCandidates.map((e) => Number(e.save_count ?? 0)));
  if (saveCount + viewCount >= maxSave * 0.5 && saveCount + viewCount > 2) {
    badges.push('TRENDING');
  }

  // GEHEIMTIPP: high quality, low discovery
  const highQuality = (s?.family_fit_score ?? 0) >= 70 || (s?.stressfree_score ?? 0) >= 70;
  if (highQuality && saveCount + viewCount < 5 && badges.indexOf('TRENDING') === -1) {
    badges.push('GEHEIMTIPP');
  }

  // MATCH: high personal match
  if (match >= 0.7 && (s?.family_fit_score ?? 0) >= 70) badges.push('MATCH');

  return badges.slice(0, 3);
}

/**
 * Build why_recommended string from ai_reasoning (first non-empty reasoning field).
 */
export function buildWhyRecommended(event: any): string | undefined {
  const reasoning = event.scores?.ai_reasoning;
  if (!reasoning || typeof reasoning !== 'object') return undefined;
  const r = reasoning as Record<string, string>;
  const keys = ['family_fit', 'relevance', 'stressfree', 'quality', 'fun'];
  for (const k of keys) {
    if (r[k] && String(r[k]).trim()) return String(r[k]).trim();
  }
  return undefined;
}

/**
 * Re-rank: enforce diversity (max 2 per category, max 2 per location), ensure at least one budget pick.
 */
export function reRank(
  scored: EventWithScores[],
  limit: number
): EventWithScores[] {
  const categoryCount = new Map<string, number>();
  const locationKey = (e: any) =>
    [e.event.location_district || '', e.event.venue_name || ''].filter(Boolean).join('|') || 'unknown';
  const locationCount = new Map<string, number>();
  const result: EventWithScores[] = [];
  const used = new Set<string>();

  const getCategoryKeys = (e: any) =>
    (e.event.categories ?? []).map((c: any) => c.category?.slug ?? c.category_id).filter(Boolean);

  const canAdd = (item: EventWithScores): boolean => {
    const id = item.event.id;
    if (used.has(id)) return false;
    const catKeys = getCategoryKeys(item);
    const locKey = locationKey(item.event);
    const maxCat = Math.max(0, ...catKeys.map((k: string) => categoryCount.get(k) ?? 0));
    if (maxCat >= 2) return false;
    if ((locationCount.get(locKey) ?? 0) >= 2) return false;
    return true;
  };

  const add = (item: EventWithScores) => {
    result.push(item);
    used.add(item.event.id);
    getCategoryKeys(item).forEach((k: string) => categoryCount.set(k, (categoryCount.get(k) ?? 0) + 1));
    locationCount.set(locationKey(item.event), (locationCount.get(locationKey(item.event)) ?? 0) + 1);
  };

  // Ensure at least one budget pick if available
  const budgetPicks = scored.filter(
    (item) =>
      item.event.price_type === 'free' || (item.event.price_min != null && item.event.price_min <= 5)
  );
  if (budgetPicks.length > 0) {
    const best = budgetPicks.sort((a, b) => b.totalScore - a.totalScore)[0];
    if (!used.has(best.event.id)) add(best);
  }

  // Fill rest by score, respecting diversity
  const rest = scored
    .filter((item) => !used.has(item.event.id))
    .sort((a, b) => b.totalScore - a.totalScore);
  for (const item of rest) {
    if (result.length >= limit) break;
    if (canAdd(item)) add(item);
  }

  // If we still have room, add by score without diversity (e.g. only 1 slot left)
  if (result.length < limit) {
    for (const item of rest) {
      if (result.length >= limit) break;
      if (!used.has(item.event.id)) add(item);
    }
  }

  return result.slice(0, limit);
}
