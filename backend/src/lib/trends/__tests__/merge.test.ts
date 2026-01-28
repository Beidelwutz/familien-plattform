import { describe, it, expect } from 'vitest';
import { mergeSuggestionsAndTrends } from '../merge';
import type { TrendOverride } from '@prisma/client';

describe('mergeSuggestionsAndTrends', () => {
  const now = new Date('2026-01-27T12:00:00Z');

  it('should hide terms', () => {
    const baseSuggestions = [
      { text: 'karlsruhe', type: 'query' as const, score: 10 },
      { text: 'museum', type: 'entity' as const, score: 5 }
    ];
    const baseTrending = [
      { text: 'fasching', badge: '🔥', score: 50 }
    ];
    const overrides: Partial<TrendOverride>[] = [
      {
        term: 'karlsruhe',
        action: 'HIDE',
        isActive: true,
        priority: 0,
        city: null,
        boost: null,
        replacement: null,
        label: null,
        startsAt: null,
        endsAt: null
      }
    ];

    const result = mergeSuggestionsAndTrends(
      baseSuggestions,
      baseTrending,
      overrides as TrendOverride[],
      now
    );
    
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].text).toBe('museum');
  });

  it('should replace terms', () => {
    const baseSuggestions = [
      { text: 'karlsruhe weihnachtsmarkt', type: 'query' as const, score: 10 }
    ];
    const overrides: Partial<TrendOverride>[] = [
      {
        term: 'karlsruhe weihnachtsmarkt',
        action: 'REPLACE',
        replacement: 'weihnachtsmarkt karlsruhe',
        isActive: true,
        priority: 0,
        city: null,
        boost: null,
        label: null,
        startsAt: null,
        endsAt: null
      }
    ];

    const result = mergeSuggestionsAndTrends(
      baseSuggestions,
      [],
      overrides as TrendOverride[],
      now
    );
    
    expect(result.suggestions[0].text).toBe('weihnachtsmarkt karlsruhe');
  });

  it('should pin terms to top', () => {
    const baseTrending = [
      { text: 'fasching', badge: '🔥', score: 50 },
      { text: 'flohmarkt', badge: '🔥', score: 40 }
    ];
    const overrides: Partial<TrendOverride>[] = [
      {
        term: 'flohmarkt',
        action: 'PIN',
        isActive: true,
        priority: 0,
        city: null,
        boost: null,
        replacement: null,
        label: null,
        startsAt: null,
        endsAt: null
      }
    ];

    const result = mergeSuggestionsAndTrends(
      [],
      baseTrending,
      overrides as TrendOverride[],
      now
    );
    
    expect(result.trending[0].text).toBe('flohmarkt');
    expect(result.trending[0].badge).toBe('📌');
  });

  it('should boost terms', () => {
    const baseTrending = [
      { text: 'fasching', badge: '🔥', score: 50 },
      { text: 'flohmarkt', badge: '🔥', score: 40 }
    ];
    const overrides: Partial<TrendOverride>[] = [
      {
        term: 'flohmarkt',
        action: 'BOOST',
        boost: 20,
        isActive: true,
        priority: 0,
        city: null,
        replacement: null,
        label: null,
        startsAt: null,
        endsAt: null
      }
    ];

    const result = mergeSuggestionsAndTrends(
      [],
      baseTrending,
      overrides as TrendOverride[],
      now
    );
    
    // After boost, flohmarkt should have score 60 and be first
    const flohmarkt = result.trending.find(t => t.text === 'flohmarkt');
    expect(flohmarkt?.score).toBe(60);
    expect(result.trending[0].text).toBe('flohmarkt');
  });

  it('should push terms into trending', () => {
    const baseTrending = [
      { text: 'fasching', badge: '🔥', score: 50 }
    ];
    const overrides: Partial<TrendOverride>[] = [
      {
        term: 'laternenumzug',
        action: 'PUSH',
        label: '✨',
        isActive: true,
        priority: 0,
        city: null,
        boost: null,
        replacement: null,
        startsAt: null,
        endsAt: null
      }
    ];

    const result = mergeSuggestionsAndTrends(
      [],
      baseTrending,
      overrides as TrendOverride[],
      now
    );
    
    expect(result.trending.some(t => t.text === 'laternenumzug')).toBe(true);
    const pushed = result.trending.find(t => t.text === 'laternenumzug');
    expect(pushed?.badge).toBe('✨');
  });

  it('should respect time windows', () => {
    const overrides: Partial<TrendOverride>[] = [
      {
        term: 'test',
        action: 'HIDE',
        isActive: true,
        startsAt: new Date('2026-01-28T00:00:00Z'),  // Future
        priority: 0,
        city: null,
        boost: null,
        replacement: null,
        label: null,
        endsAt: null
      }
    ];

    const result = mergeSuggestionsAndTrends(
      [{ text: 'test', type: 'query' as const, score: 10 }],
      [],
      overrides as TrendOverride[],
      now
    );
    
    // Override not active yet
    expect(result.suggestions).toHaveLength(1);
  });

  it('should not apply inactive overrides', () => {
    const baseSuggestions = [
      { text: 'test', type: 'query' as const, score: 10 }
    ];
    const overrides: Partial<TrendOverride>[] = [
      {
        term: 'test',
        action: 'HIDE',
        isActive: false,
        priority: 0,
        city: null,
        boost: null,
        replacement: null,
        label: null,
        startsAt: null,
        endsAt: null
      }
    ];

    const result = mergeSuggestionsAndTrends(
      baseSuggestions,
      [],
      overrides as TrendOverride[],
      now
    );
    
    expect(result.suggestions).toHaveLength(1);
  });

  it('should deduplicate suggestions', () => {
    const baseSuggestions = [
      { text: 'Karlsruhe', type: 'entity' as const, score: 10 },
      { text: 'karlsruhe', type: 'query' as const, score: 5 }
    ];

    const result = mergeSuggestionsAndTrends(
      baseSuggestions,
      [],
      [],
      now
    );
    
    // Should keep only one (first occurrence)
    expect(result.suggestions).toHaveLength(1);
  });

  it('should limit suggestions to 8', () => {
    const baseSuggestions = Array.from({ length: 20 }, (_, i) => ({
      text: `term${i}`,
      type: 'query' as const,
      score: 20 - i
    }));

    const result = mergeSuggestionsAndTrends(
      baseSuggestions,
      [],
      [],
      now
    );
    
    expect(result.suggestions.length).toBeLessThanOrEqual(8);
  });

  it('should limit trending to 6', () => {
    const baseTrending = Array.from({ length: 15 }, (_, i) => ({
      text: `trend${i}`,
      badge: '🔥',
      score: 100 - i
    }));

    const result = mergeSuggestionsAndTrends(
      [],
      baseTrending,
      [],
      now
    );
    
    expect(result.trending.length).toBeLessThanOrEqual(6);
  });
});
