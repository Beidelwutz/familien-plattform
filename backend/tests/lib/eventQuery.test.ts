import { describe, it, expect } from 'vitest';
import { 
  whereDisplayable, 
  whereDisplayableWith,
  canPublish,
  isAgeRatingAllowed,
  RESTRICTED_AGE_RATINGS 
} from '../../src/lib/eventQuery.js';

describe('whereDisplayable', () => {
  it('returns correct base filter structure', () => {
    const now = new Date('2026-01-31T12:00:00Z');
    const where = whereDisplayable(now);
    
    expect(where.status).toBe('published');
    expect(where.is_cancelled).toBe(false);
    expect(where.start_datetime).toEqual({ gte: now });
  });

  it('excludes 16+ and 18+ events via OR clause', () => {
    const where = whereDisplayable();
    
    expect(where.OR).toBeDefined();
    expect(where.OR).toHaveLength(2);
    
    // Should allow null age_rating
    expect(where.OR).toContainEqual({ age_rating: null });
    
    // Should exclude restricted ratings
    expect(where.OR).toContainEqual({ 
      age_rating: { notIn: ['16+', '18+'] } 
    });
  });

  it('uses current date as default', () => {
    const before = new Date();
    const where = whereDisplayable();
    const after = new Date();
    
    const filterDate = where.start_datetime.gte as Date;
    expect(filterDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(filterDate.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

describe('whereDisplayableWith', () => {
  it('combines displayable filter with additional filters', () => {
    const now = new Date('2026-01-31T12:00:00Z');
    const additionalFilters = {
      created_at: { gte: new Date('2026-01-01') }
    };
    
    const where = whereDisplayableWith(now, additionalFilters);
    
    expect(where.AND).toBeDefined();
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0]).toEqual(whereDisplayable(now));
    expect(where.AND[1]).toEqual(additionalFilters);
  });
});

describe('canPublish', () => {
  const validEvent = {
    title: 'Test Event Title',
    start_datetime: new Date('2026-02-15T14:00:00Z'),
    location_address: 'Musterstraße 1, 76131 Karlsruhe',
    location_lat: null,
    location_lng: null,
    is_cancelled: false,
    age_rating: null
  };

  it('returns valid for complete event', () => {
    const result = canPublish(validEvent);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('rejects when title is missing', () => {
    const result = canPublish({ ...validEvent, title: null });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Titel');
  });

  it('rejects when title is too short', () => {
    const result = canPublish({ ...validEvent, title: 'Test' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('mindestens 5 Zeichen');
  });

  it('rejects when start_datetime is missing', () => {
    const result = canPublish({ ...validEvent, start_datetime: null });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Startdatum');
  });

  it('rejects when both address and coordinates are missing', () => {
    const result = canPublish({ 
      ...validEvent, 
      location_address: null,
      location_lat: null,
      location_lng: null 
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Adresse oder Koordinaten');
  });

  it('accepts when only coordinates are provided', () => {
    const result = canPublish({ 
      ...validEvent, 
      location_address: null,
      location_lat: 49.0069,
      location_lng: 8.4037
    });
    expect(result.valid).toBe(true);
  });

  it('accepts when only address is provided', () => {
    const result = canPublish({ 
      ...validEvent, 
      location_lat: null,
      location_lng: null
    });
    expect(result.valid).toBe(true);
  });

  it('rejects cancelled events', () => {
    const result = canPublish({ ...validEvent, is_cancelled: true });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('abgesagt');
  });

  it('rejects age_rating 16+', () => {
    const result = canPublish({ ...validEvent, age_rating: '16+' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('16+');
    expect(result.reason).toContain('nicht für Familienseite');
  });

  it('rejects age_rating 18+', () => {
    const result = canPublish({ ...validEvent, age_rating: '18+' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('18+');
  });

  it('allows age_rating 6+', () => {
    const result = canPublish({ ...validEvent, age_rating: '6+' });
    expect(result.valid).toBe(true);
  });

  it('allows age_rating 13+', () => {
    const result = canPublish({ ...validEvent, age_rating: '13+' });
    expect(result.valid).toBe(true);
  });
});

describe('isAgeRatingAllowed', () => {
  it('returns true for null/undefined', () => {
    expect(isAgeRatingAllowed(null)).toBe(true);
    expect(isAgeRatingAllowed(undefined)).toBe(true);
  });

  it('returns true for allowed ratings', () => {
    expect(isAgeRatingAllowed('0+')).toBe(true);
    expect(isAgeRatingAllowed('3+')).toBe(true);
    expect(isAgeRatingAllowed('6+')).toBe(true);
    expect(isAgeRatingAllowed('10+')).toBe(true);
    expect(isAgeRatingAllowed('13+')).toBe(true);
  });

  it('returns false for restricted ratings', () => {
    expect(isAgeRatingAllowed('16+')).toBe(false);
    expect(isAgeRatingAllowed('18+')).toBe(false);
  });
});

describe('RESTRICTED_AGE_RATINGS', () => {
  it('contains expected restricted ratings', () => {
    expect(RESTRICTED_AGE_RATINGS).toContain('16+');
    expect(RESTRICTED_AGE_RATINGS).toContain('18+');
    expect(RESTRICTED_AGE_RATINGS).toHaveLength(2);
  });
});
