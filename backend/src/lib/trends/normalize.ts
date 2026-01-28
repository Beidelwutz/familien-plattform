/**
 * String normalization for search query matching
 */

export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')  // Multiple spaces to single space
    .slice(0, 120);
}
