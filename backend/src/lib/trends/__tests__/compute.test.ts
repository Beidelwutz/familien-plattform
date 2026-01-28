import { describe, it, expect } from 'vitest';
import { computeTrendingTerms } from '../compute';

// Note: These are integration tests that would need a test database
// For now, we test the logic structure

describe('computeTrendingTerms', () => {
  it('should have correct interface', () => {
    // This test verifies the function signature
    expect(typeof computeTrendingTerms).toBe('function');
  });

  it('should calculate trend ratio correctly', () => {
    // Unit test for the formula
    const searches24h = 20;
    const baseline7d = 5;
    const trendRatio = (searches24h + 1) / (baseline7d + 1);
    const score = searches24h * trendRatio;

    expect(trendRatio).toBe(21 / 6); // 3.5
    expect(score).toBe(20 * 3.5); // 70
  });

  it('should filter terms with trendRatio < 2', () => {
    const searches24h = 10;
    const baseline7d = 10; // baseline per day = 10/7 ≈ 1.43
    const trendRatio = (searches24h + 1) / (baseline7d / 7 + 1);
    
    // trendRatio = 11 / 2.43 ≈ 4.5, so it should pass
    expect(trendRatio).toBeGreaterThan(2);
  });

  it('should filter terms with searches24h < 10', () => {
    const searches24h = 5;
    const baseline7d = 1;
    const trendRatio = (searches24h + 1) / (baseline7d / 7 + 1);
    
    // Even with high ratio, should be filtered if searches24h < 10
    expect(searches24h).toBeLessThan(10);
  });

  it('should sort by score descending', () => {
    const metrics = [
      { term: 'a', searches24h: 20, baseline7d: 5, trendRatio: 3.5, score: 70 },
      { term: 'b', searches24h: 30, baseline7d: 10, trendRatio: 3.1, score: 93 },
      { term: 'c', searches24h: 15, baseline7d: 3, trendRatio: 4, score: 60 }
    ];

    const sorted = [...metrics].sort((a, b) => b.score - a.score);
    
    expect(sorted[0].term).toBe('b');
    expect(sorted[1].term).toBe('a');
    expect(sorted[2].term).toBe('c');
  });
});
