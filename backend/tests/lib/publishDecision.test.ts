import { describe, it, expect } from 'vitest';
import { 
  computePublishDecision, 
  THRESHOLDS,
  type DecisionInput,
  type DecisionResult 
} from '../../src/lib/publishDecision.js';

describe('computePublishDecision', () => {
  describe('Age Rating Rules', () => {
    it('rejects age_rating 16+', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 70,
        confidence: 0.9,
        age_rating: '16+'
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('rejected');
      expect(result.flags).toContain('age_restricted');
      expect(result.reason).toContain('16+');
    });

    it('rejects age_rating 18+', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 90,
        confidence: 0.95,
        age_rating: '18+'
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('rejected');
      expect(result.flags).toContain('age_restricted');
    });

    it('allows age_rating 0+', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 70,
        confidence: 0.85,
        age_rating: '0+'
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).not.toBe('rejected');
      expect(result.flags).not.toContain('age_restricted');
    });

    it('allows null age_rating', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 70,
        confidence: 0.85,
        age_rating: null
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).not.toBe('rejected');
    });
  });

  describe('Completeness Rules', () => {
    it('returns incomplete when completeness < 50%', () => {
      const input: DecisionInput = {
        completeness_score: 30,
        family_fit_score: 70,
        confidence: 0.9,
        age_rating: null
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('incomplete');
      expect(result.flags).toContain('low_completeness');
    });

    it('proceeds with completeness >= 50%', () => {
      const input: DecisionInput = {
        completeness_score: 50,
        family_fit_score: 70,
        confidence: 0.85,
        age_rating: null
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).not.toBe('incomplete');
    });
  });

  describe('Family Fit + Confidence Rules', () => {
    it('rejects low family_fit with high confidence', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 20,
        confidence: 0.85,
        age_rating: null
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('rejected');
      expect(result.flags).toContain('low_family_fit');
    });

    it('sends to review when confidence < 0.75', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 70,
        confidence: 0.5,
        age_rating: null
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('pending_review');
      expect(result.flags).toContain('low_confidence');
    });

    it('sends to review when family_fit is borderline (30-49)', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 40,
        confidence: 0.85,
        age_rating: null
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('pending_review');
      expect(result.flags).toContain('borderline_family_fit');
    });
  });

  describe('Auto-Publish Rules', () => {
    it('auto-publishes with high confidence + good family_fit + booking_url', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 60,
        confidence: 0.85,
        age_rating: '6+',
        booking_url: 'https://example.com/event'
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('published');
      expect(result.flags).toContain('auto_published');
    });

    it('auto-publishes edge case: family_fit=50, confidence=0.75', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 50,
        confidence: 0.75,
        age_rating: null,
        booking_url: 'https://example.com/event'
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('published');
    });
  });

  describe('Booking URL Rules', () => {
    it('sends to review when booking_url is missing', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 70,
        confidence: 0.9,
        age_rating: null,
        booking_url: null
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('pending_review');
      expect(result.flags).toContain('no_booking_url');
      expect(result.reason).toContain('Link');
    });

    it('sends to review when booking_url is empty string', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 70,
        confidence: 0.9,
        age_rating: null,
        booking_url: ''
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('pending_review');
      expect(result.flags).toContain('no_booking_url');
    });

    it('allows publishing when booking_url is present', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: 70,
        confidence: 0.85,
        age_rating: null,
        booking_url: 'https://example.com/event'
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('published');
      expect(result.flags).not.toContain('no_booking_url');
    });
  });

  describe('No AI Scores', () => {
    it('sends to review when no AI scores present', () => {
      const input: DecisionInput = {
        completeness_score: 80,
        family_fit_score: null,
        confidence: null,
        age_rating: null
      };
      
      const result = computePublishDecision(input);
      
      expect(result.status).toBe('pending_review');
      expect(result.flags).toContain('no_ai_scores');
    });
  });

  describe('Threshold Constants', () => {
    it('has expected threshold values', () => {
      expect(THRESHOLDS.CONFIDENCE_PUBLISH).toBe(0.75);
      expect(THRESHOLDS.CONFIDENCE_REJECT).toBe(0.80);
      expect(THRESHOLDS.FAMILY_FIT_REJECT).toBe(30);
      expect(THRESHOLDS.FAMILY_FIT_PUBLISH).toBe(50);
      expect(THRESHOLDS.COMPLETENESS_MIN).toBe(50);
    });
  });
});
