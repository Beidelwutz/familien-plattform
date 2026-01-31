/**
 * Publishing Decision Logic
 * 
 * Zentrale Logik für automatische/manuelle Veröffentlichungsentscheidungen
 * basierend auf AI-Scores und Event-Qualität.
 */

import { RESTRICTED_AGE_RATINGS } from './eventQuery.js';

/**
 * Schwellenwerte für Veröffentlichungsentscheidungen
 * 
 * Diese können über Environment-Variablen angepasst werden (optional):
 * - PUBLISH_CONFIDENCE_MIN: Min. Konfidenz für Auto-Publish
 * - PUBLISH_CONFIDENCE_REJECT: Min. Konfidenz für Auto-Reject
 * - PUBLISH_FAMILY_FIT_REJECT: family_fit < X => rejected
 * - PUBLISH_FAMILY_FIT_MIN: family_fit >= X => kann auto-publish
 * - PUBLISH_COMPLETENESS_MIN: Min. Completeness für Verarbeitung
 */
export const THRESHOLDS = {
  /** Minimale Konfidenz für automatische Veröffentlichung */
  CONFIDENCE_PUBLISH: parseFloat(process.env.PUBLISH_CONFIDENCE_MIN || '0.75'),
  
  /** Minimale Konfidenz für automatische Ablehnung */
  CONFIDENCE_REJECT: parseFloat(process.env.PUBLISH_CONFIDENCE_REJECT || '0.80'),
  
  /** family_fit unter diesem Wert => rejected */
  FAMILY_FIT_REJECT: parseInt(process.env.PUBLISH_FAMILY_FIT_REJECT || '30', 10),
  
  /** family_fit ab diesem Wert kann auto-published werden */
  FAMILY_FIT_PUBLISH: parseInt(process.env.PUBLISH_FAMILY_FIT_MIN || '50', 10),
  
  /** Minimale Completeness für Verarbeitung */
  COMPLETENESS_MIN: parseInt(process.env.PUBLISH_COMPLETENESS_MIN || '50', 10),
} as const;

/**
 * Mögliche Veröffentlichungsentscheidungen
 */
export type PublishDecision = 'published' | 'pending_review' | 'rejected' | 'incomplete';

/**
 * Input für die Entscheidungsfunktion
 */
export interface DecisionInput {
  /** Completeness Score 0-100 */
  completeness_score: number;
  /** Family Fit Score 0-100 (null = nicht berechnet) */
  family_fit_score: number | null;
  /** AI Confidence 0.0-1.0 (null = nicht berechnet) */
  confidence: number | null;
  /** Age Rating z.B. "0+", "6+", "16+" */
  age_rating: string | null;
  /** Booking/Event URL - wenn fehlend, zur Review */
  booking_url?: string | null;
}

/**
 * Result der Entscheidungsfunktion
 */
export interface DecisionResult {
  /** Die Entscheidung */
  status: PublishDecision;
  /** Menschenlesbare Begründung */
  reason: string;
  /** Flags für Debugging/Logging */
  flags: string[];
}

/**
 * Berechnet die Veröffentlichungsentscheidung basierend auf AI-Scores
 * 
 * Entscheidungslogik:
 * 
 * 1. HARD RULE: age_rating 16+/18+ => immer rejected (nicht familiengeeignet)
 * 
 * 2. completeness < 50% => incomplete (braucht mehr Daten)
 * 
 * 3. kein booking_url => pending_review (Link fehlt, manuelle Prüfung)
 * 
 * 4. family_fit < 30 UND confidence >= 0.80 => rejected (sicher nicht geeignet)
 * 
 * 5. confidence < 0.75 => pending_review (AI unsicher)
 * 
 * 6. family_fit 30-49 => pending_review (Grenzfall)
 * 
 * 7. family_fit >= 50 UND confidence >= 0.75 => published (auto-publish)
 * 
 * 8. Default => pending_review
 * 
 * @param input - Die Eingabewerte
 * @returns Das Entscheidungsergebnis
 */
export function computePublishDecision(input: DecisionInput): DecisionResult {
  const flags: string[] = [];
  
  // ============================================
  // HARD RULE: Age Rating Check
  // ============================================
  if (input.age_rating && RESTRICTED_AGE_RATINGS.includes(input.age_rating as typeof RESTRICTED_AGE_RATINGS[number])) {
    return {
      status: 'rejected',
      reason: `age_rating ${input.age_rating} nicht für Familienseite geeignet`,
      flags: ['age_restricted']
    };
  }
  
  // ============================================
  // Completeness Check
  // ============================================
  if (input.completeness_score < THRESHOLDS.COMPLETENESS_MIN) {
    return {
      status: 'incomplete',
      reason: `Completeness ${input.completeness_score}% < ${THRESHOLDS.COMPLETENESS_MIN}% (Mindestanforderung)`,
      flags: ['low_completeness']
    };
  }
  
  // ============================================
  // Booking URL Check (Soft Rule - zur Review, nicht blockieren)
  // ============================================
  if (!input.booking_url) {
    flags.push('no_booking_url');
  }
  
  // ============================================
  // AI Score Based Decision
  // ============================================
  
  // Default-Werte wenn AI-Scores fehlen
  const familyFit = input.family_fit_score ?? 50;
  const confidence = input.confidence ?? 0.5;
  
  // Keine AI-Scores => zur manuellen Prüfung
  if (input.family_fit_score === null || input.confidence === null) {
    flags.push('no_ai_scores');
    return {
      status: 'pending_review',
      reason: 'Keine AI-Scores vorhanden - manuelle Prüfung erforderlich',
      flags
    };
  }
  
  // Low family fit mit hoher Confidence => definitiv ablehnen
  if (familyFit < THRESHOLDS.FAMILY_FIT_REJECT && confidence >= THRESHOLDS.CONFIDENCE_REJECT) {
    return {
      status: 'rejected',
      reason: `family_fit ${familyFit}% < ${THRESHOLDS.FAMILY_FIT_REJECT}% mit confidence ${(confidence * 100).toFixed(0)}%`,
      flags: ['low_family_fit', 'high_confidence_reject']
    };
  }
  
  // Confidence sammeln für Review-Entscheidung
  if (confidence < THRESHOLDS.CONFIDENCE_PUBLISH) {
    flags.push('low_confidence');
  }
  
  // Borderline family fit
  if (familyFit >= THRESHOLDS.FAMILY_FIT_REJECT && familyFit < THRESHOLDS.FAMILY_FIT_PUBLISH) {
    flags.push('borderline_family_fit');
  }
  
  // Wenn Flags vorhanden => zur manuellen Prüfung
  if (flags.length > 0) {
    return {
      status: 'pending_review',
      reason: flags.map(f => {
        switch (f) {
          case 'low_confidence': return `AI unsicher (${(confidence * 100).toFixed(0)}% < ${THRESHOLDS.CONFIDENCE_PUBLISH * 100}%)`;
          case 'borderline_family_fit': return `Grenzfall family_fit (${familyFit}%)`;
          case 'no_booking_url': return 'Kein Buchungs-/Event-Link vorhanden';
          default: return f;
        }
      }).join(', '),
      flags
    };
  }
  
  // ============================================
  // Auto-Publish
  // ============================================
  if (familyFit >= THRESHOLDS.FAMILY_FIT_PUBLISH && confidence >= THRESHOLDS.CONFIDENCE_PUBLISH) {
    return {
      status: 'published',
      reason: `Auto-publish: family_fit ${familyFit}% >= ${THRESHOLDS.FAMILY_FIT_PUBLISH}%, confidence ${(confidence * 100).toFixed(0)}% >= ${THRESHOLDS.CONFIDENCE_PUBLISH * 100}%`,
      flags: ['auto_published']
    };
  }
  
  // ============================================
  // Default: Manual Review
  // ============================================
  return {
    status: 'pending_review',
    reason: 'Standardfall: Manuelle Prüfung erforderlich',
    flags: []
  };
}

/**
 * Logging helper für Status-Übergänge
 */
export function logStatusTransition(
  eventId: string,
  fromStatus: string | null,
  toStatus: string,
  decision: DecisionResult
): void {
  console.log(JSON.stringify({
    type: 'status_transition',
    event_id: eventId,
    from_status: fromStatus,
    to_status: toStatus,
    reason: decision.reason,
    flags: decision.flags,
    timestamp: new Date().toISOString()
  }));
}
