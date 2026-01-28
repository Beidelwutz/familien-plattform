/**
 * Completeness score calculation for events
 * 
 * Weighted fields:
 * - Title: 10%
 * - Description: 15%
 * - DateTime: 20%
 * - Location: 20%
 * - Price: 10%
 * - Age: 10%
 * - Contact: 10%
 * - Categories: 5%
 */

export interface CompletenessResult {
  score: number;
  isComplete: boolean;
  missingFields: string[];
}

const COMPLETENESS_THRESHOLD = 70;

interface EventData {
  title?: string | null;
  description_short?: string | null;
  description_long?: string | null;
  start_datetime?: Date | string | null;
  end_datetime?: Date | string | null;
  location_address?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  price_type?: string | null;
  price_min?: number | null;
  age_min?: number | null;
  age_max?: number | null;
  booking_url?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  categories?: any[] | null;
}

export function calculateCompleteness(event: EventData): CompletenessResult {
  let score = 0;
  const missingFields: string[] = [];
  
  // Title (10%) - required
  if (event.title && event.title.length >= 5) {
    score += 10;
  } else {
    missingFields.push('title');
  }
  
  // Description (15%)
  const hasShortDesc = event.description_short && event.description_short.length >= 20;
  const hasLongDesc = event.description_long && event.description_long.length >= 50;
  
  if (hasShortDesc && hasLongDesc) {
    score += 15;
  } else if (hasShortDesc || hasLongDesc) {
    score += 10;
  } else {
    missingFields.push('description');
  }
  
  // DateTime (20%) - required
  if (event.start_datetime) {
    score += 15;
    if (event.end_datetime) {
      score += 5;
    }
  } else {
    missingFields.push('start_datetime');
  }
  
  // Location (20%)
  const hasAddress = event.location_address && event.location_address.length >= 10;
  const hasCoords = event.location_lat != null && event.location_lng != null;
  
  if (hasAddress && hasCoords) {
    score += 20;
  } else if (hasAddress || hasCoords) {
    score += 12;
  } else {
    missingFields.push('location');
  }
  
  // Price (10%)
  if (event.price_type && event.price_type !== 'unknown') {
    score += 7;
    if (event.price_type === 'paid' && event.price_min != null) {
      score += 3;
    } else if (event.price_type === 'free') {
      score += 3;
    }
  } else {
    missingFields.push('price');
  }
  
  // Age (10%)
  if (event.age_min != null || event.age_max != null) {
    score += 10;
  } else {
    missingFields.push('age_range');
  }
  
  // Contact (10%)
  const hasBookingUrl = event.booking_url && event.booking_url.length > 0;
  const hasEmail = event.contact_email && event.contact_email.length > 0;
  const hasPhone = event.contact_phone && event.contact_phone.length > 0;
  
  if (hasBookingUrl) {
    score += 6;
  }
  if (hasEmail || hasPhone) {
    score += 4;
  }
  if (!hasBookingUrl && !hasEmail && !hasPhone) {
    missingFields.push('contact');
  }
  
  // Categories (5%)
  if (event.categories && event.categories.length > 0) {
    score += 5;
  } else {
    missingFields.push('categories');
  }
  
  return {
    score: Math.min(100, Math.round(score)),
    isComplete: score >= COMPLETENESS_THRESHOLD,
    missingFields,
  };
}

/**
 * Determines the initial status based on completeness
 */
export function determineInitialStatus(completeness: CompletenessResult): string {
  if (completeness.score < 50) {
    return 'incomplete';
  }
  if (completeness.score < COMPLETENESS_THRESHOLD) {
    return 'pending_ai';
  }
  return 'pending_review';
}
