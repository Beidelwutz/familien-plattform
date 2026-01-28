/**
 * Pagination Utility Tests
 */

import { describe, it, expect } from 'vitest';
import {
  parsePaginationParams,
  createPaginationResult,
  getEventSortConfig,
  getDateRangeFilter,
  MAX_LIMIT,
  DEFAULT_LIMIT,
} from '../../src/lib/pagination.js';

describe('Pagination Utilities', () => {
  describe('parsePaginationParams', () => {
    it('should use default values when no params provided', () => {
      const result = parsePaginationParams({});

      expect(result.page).toBe(1);
      expect(result.limit).toBe(DEFAULT_LIMIT);
      expect(result.offset).toBe(0);
    });

    it('should parse page and limit correctly', () => {
      const result = parsePaginationParams({ page: '3', limit: '25' });

      expect(result.page).toBe(3);
      expect(result.limit).toBe(25);
      expect(result.offset).toBe(50); // (3-1) * 25
    });

    it('should enforce maximum limit', () => {
      const result = parsePaginationParams({ limit: '500' });

      expect(result.limit).toBe(MAX_LIMIT);
    });

    it('should enforce minimum page of 1', () => {
      const result = parsePaginationParams({ page: '0' });

      expect(result.page).toBe(1);
    });

    it('should handle negative values', () => {
      const result = parsePaginationParams({ page: '-5', limit: '-10' });

      expect(result.page).toBe(1);
      expect(result.limit).toBeGreaterThan(0);
    });
  });

  describe('createPaginationResult', () => {
    it('should create correct pagination result', () => {
      const result = createPaginationResult(100, 1, 20);

      expect(result).toEqual({
        page: 1,
        limit: 20,
        total: 100,
        totalPages: 5,
      });
    });

    it('should calculate totalPages correctly', () => {
      expect(createPaginationResult(100, 1, 30).totalPages).toBe(4); // 100/30 = 3.33 -> 4
      expect(createPaginationResult(60, 1, 20).totalPages).toBe(3);
      expect(createPaginationResult(0, 1, 20).totalPages).toBe(0);
    });

    it('should handle edge case with 1 item', () => {
      const result = createPaginationResult(1, 1, 20);

      expect(result.totalPages).toBe(1);
    });
  });

  describe('getEventSortConfig', () => {
    it('should return correct sort for soonest', () => {
      const config = getEventSortConfig('soonest');

      expect(config).toHaveLength(1);
      expect(config[0]).toHaveProperty('start_datetime', 'asc');
    });

    it('should return correct sort for newest', () => {
      const config = getEventSortConfig('newest');

      expect(config).toHaveLength(1);
      expect(config[0]).toHaveProperty('created_at', 'desc');
    });

    it('should return default sort for unknown option', () => {
      const config = getEventSortConfig('unknown' as any);

      // Should default to relevance or soonest
      expect(config).toBeDefined();
      expect(Array.isArray(config)).toBe(true);
    });
  });

  describe('getDateRangeFilter', () => {
    it('should create filter for single date', () => {
      const filter = getDateRangeFilter('2025-01-15');

      expect(filter).toBeDefined();
      expect(filter).toHaveProperty('gte');
      expect(filter).toHaveProperty('lt');
    });

    it('should create filter for date range', () => {
      const filter = getDateRangeFilter('2025-01-15', '2025-01-20');

      expect(filter).toBeDefined();
      expect(filter).toHaveProperty('gte');
      expect(filter).toHaveProperty('lt');
    });

    it('should return undefined for empty input', () => {
      const filter = getDateRangeFilter();

      expect(filter).toBeUndefined();
    });
  });
});
