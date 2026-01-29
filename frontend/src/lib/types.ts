/**
 * Shared types for the Frontend
 */

// ============================================
// ENUMS
// ============================================

export type EventStatus = 
  | 'raw'
  | 'incomplete'
  | 'pending_ai'
  | 'pending_review'
  | 'published'
  | 'stale'
  | 'archived'
  | 'rejected';

export type PriceType = 'free' | 'paid' | 'range' | 'unknown';

export type SourceType = 'api' | 'rss' | 'ics' | 'scraper' | 'partner' | 'manual';

export type HealthStatus = 'healthy' | 'degraded' | 'failing' | 'dead' | 'unknown';

export type ProviderType = 'verein' | 'schule' | 'camp' | 'museum' | 'cafe' | 'other';

export type SubscriptionTier = 'free' | 'basic' | 'pro';

export type UserRole = 'parent' | 'provider' | 'admin';

export type SlotType = 'activity' | 'break' | 'travel';

// ============================================
// CORE TYPES
// ============================================

export interface Event {
  id: string;
  title: string;
  description_short?: string;
  description_long?: string;
  start_datetime: string;
  end_datetime?: string;
  location_address?: string;
  location_district?: string;
  location_lat?: number;
  location_lng?: number;
  price_type: PriceType;
  price_min?: number;
  price_max?: number;
  age_min?: number;
  age_max?: number;
  is_indoor: boolean;
  is_outdoor: boolean;
  booking_url?: string;
  contact_email?: string;
  contact_phone?: string;
  image_urls?: string[];
  status: EventStatus;
  is_complete: boolean;
  is_verified: boolean;
  completeness_score?: number;
  last_verified_at?: string;
  categories?: CategoryRef[];
  scores?: EventScores;
  amenities?: AmenityRef[];
  provider?: ProviderRef;
  created_at: string;
  updated_at: string;
}

export interface EventScores {
  relevance_score?: number;
  quality_score?: number;
  family_fit_score?: number;
  stressfree_score?: number;
  confidence?: number;
  ai_model_version?: string;
  scored_at: string;
}

export interface CategoryRef {
  category_id: string;
  category?: Category;
}

export interface Category {
  id: string;
  slug: string;
  name_de: string;
  icon?: string;
  parent_id?: string;
}

export interface AmenityRef {
  amenity_id: string;
  is_confirmed: boolean;
  amenity?: Amenity;
}

export interface Amenity {
  id: string;
  slug: string;
  name_de: string;
  icon?: string;
}

export interface ProviderRef {
  id: string;
  name: string;
  type: ProviderType;
}

// ============================================
// SOURCE TYPES
// ============================================

export interface Source {
  id: string;
  name: string;
  type: SourceType;
  url?: string;
  schedule_cron?: string;
  is_active: boolean;
  health_status: HealthStatus;
  consecutive_failures: number;
  last_fetch_at?: string;
  last_success_at?: string;
  last_failure_at?: string;
  scrape_allowed: boolean;
  rate_limit_ms: number;
  priority: number;
  expected_event_count_min?: number;
}

export interface SourceFetchLog {
  id: string;
  source_id: string;
  started_at: string;
  finished_at?: string;
  status: 'running' | 'success' | 'partial' | 'error';
  events_found?: number;
  events_new?: number;
  events_updated?: number;
  error_message?: string;
}

// ============================================
// USER TYPES
// ============================================

export interface User {
  id: string;
  email: string;
  role: UserRole;
  created_at: string;
}

export interface FamilyProfile {
  id: string;
  user_id: string;
  children_ages?: ChildInfo[];
  preferred_radius_km?: number;
  preferred_categories?: string[];
  home_lat?: number;
  home_lng?: number;
}

export interface ChildInfo {
  name?: string;
  birthdate: string;
}

// ============================================
// PLAN TYPES
// ============================================

export interface Plan {
  id: string;
  user_id?: string;
  title?: string;
  date: string;
  children_ages?: number[];
  budget?: number;
  estimated_cost?: number;
  slots: PlanSlot[];
  plan_b_slots?: PlanSlot[];
  tips?: string[];
  created_at: string;
}

export interface PlanSlot {
  id?: string;
  event_id?: string;
  event?: Partial<Event>;
  slot_type: SlotType;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  notes?: string;
}

// ============================================
// API TYPES
// ============================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  message: string;
  code: string;
  details?: Record<string, unknown>;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ============================================
// SEARCH/FILTER TYPES
// ============================================

export interface EventSearchParams {
  q?: string;
  lat?: number;
  lng?: number;
  radius?: number;
  date?: string;
  dateEnd?: string;
  ageMin?: number;
  ageMax?: number;
  priceMax?: number;
  categories?: string[];
  indoor?: boolean;
  outdoor?: boolean;
  page?: number;
  limit?: number;
}

export interface PlanRequest {
  children_ages: number[];
  date: string;
  budget?: number;
  lat?: number;
  lng?: number;
  preferences?: {
    indoor?: boolean;
    outdoor?: boolean;
    categories?: string[];
  };
}

// ============================================
// FRONTEND-SPECIFIC TYPES
// ============================================

/** Local storage saved event IDs */
export interface LocalSavedEvents {
  ids: string[];
  lastUpdated: string;
}

/** Cookie consent preferences */
export interface CookieConsent {
  version: string;
  necessary: boolean;
  functional: boolean;
  analytics: boolean;
  timestamp: string;
}

/** Auth state for client-side */
export interface AuthState {
  token: string | null;
  user: User | null;
  isLoading: boolean;
  error: string | null;
}

/** Event card display props */
export interface EventCardProps {
  id: string;
  title: string;
  startDatetime?: string;
  locationAddress?: string;
  priceType?: PriceType;
  priceMin?: number;
  priceMax?: number;
  ageMin?: number;
  ageMax?: number;
  isIndoor?: boolean;
  isOutdoor?: boolean;
  imageUrl?: string;
  stressfreeScore?: number;
  isSaved?: boolean;
}

/** Search result from API */
export interface SearchResult {
  events: Event[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Map marker for events */
export interface EventMarker {
  id: string;
  lat: number;
  lng: number;
  title: string;
  priceType?: PriceType;
}
