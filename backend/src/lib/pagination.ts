/**
 * Pagination utilities
 */

export interface PaginationParams {
  page?: number;
  limit?: number;
  cursor?: string;
}

export interface PaginationResult {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  nextCursor?: string;
}

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

/**
 * Parse and validate pagination parameters
 */
export function parsePaginationParams(query: Record<string, any>): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = Math.max(1, parseInt(query.page) || DEFAULT_PAGE);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit) || DEFAULT_LIMIT));
  const skip = (page - 1) * limit;

  return { page, limit, skip };
}

/**
 * Create pagination result object
 */
export function createPaginationResult(
  page: number,
  limit: number,
  total: number,
  nextCursor?: string
): PaginationResult {
  const totalPages = Math.ceil(total / limit);
  
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    nextCursor,
  };
}

/**
 * Sort options for events
 */
export type EventSortOption = 'soonest' | 'nearest' | 'newest' | 'relevance';

export interface EventSortConfig {
  orderBy: any[];
  requiresLocation: boolean;
}

/**
 * Get Prisma orderBy clause for event sorting
 */
export function getEventSortConfig(sort: EventSortOption = 'soonest'): EventSortConfig {
  switch (sort) {
    case 'soonest':
      return {
        orderBy: [{ start_datetime: 'asc' }],
        requiresLocation: false,
      };
    case 'newest':
      return {
        orderBy: [{ created_at: 'desc' }, { start_datetime: 'asc' }],
        requiresLocation: false,
      };
    case 'relevance':
      return {
        orderBy: [
          { scores: { family_fit_score: 'desc' } },
          { scores: { stressfree_score: 'desc' } },
          { start_datetime: 'asc' },
        ],
        requiresLocation: false,
      };
    case 'nearest':
      // Note: actual distance sorting requires PostGIS raw query
      return {
        orderBy: [{ start_datetime: 'asc' }],
        requiresLocation: true,
      };
    default:
      return {
        orderBy: [{ start_datetime: 'asc' }],
        requiresLocation: false,
      };
  }
}

/**
 * Date range filter helpers
 */
export function getDateRangeFilter(dateFrom?: string, dateTo?: string) {
  const now = new Date();
  const defaultDateTo = new Date(now);
  defaultDateTo.setDate(defaultDateTo.getDate() + 30);

  const from = dateFrom ? new Date(dateFrom) : now;
  const to = dateTo ? new Date(dateTo) : defaultDateTo;

  return {
    gte: from,
    lte: to,
  };
}
