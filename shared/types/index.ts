// Shared TypeScript types for kiezling

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

export type AvailabilityStatus = 'available' | 'sold_out' | 'waitlist' | 'registration_required' | 'unknown';

export type ComplexityLevel = 'simple' | 'moderate' | 'advanced';

export type NoiseLevel = 'quiet' | 'moderate' | 'loud';

export type SourceType = 'api' | 'rss' | 'ics' | 'scraper' | 'partner' | 'manual';

export type HealthStatus = 'healthy' | 'degraded' | 'failing' | 'dead' | 'unknown';

export type ProviderType = 'verein' | 'unternehmen' | 'kommune' | 'kita' | 'freiberuflich' | 'sonstiges';

export type SubscriptionTier = 'free' | 'basic' | 'pro';

export type UserRole = 'parent' | 'provider' | 'admin';

export type SlotType = 'activity' | 'break' | 'travel';

// ============================================
// CORE TYPES
// ============================================

export interface PriceDetails {
  adult?: { min?: number; max?: number };
  child?: { min?: number; max?: number };
  family?: { min?: number; max?: number };
  currency?: string;
}

export interface Event {
  id: string;
  title: string;
  description_short?: string;
  description_long?: string;
  
  // DateTime
  start_datetime: string; // ISO 8601
  end_datetime?: string;
  is_all_day?: boolean;
  
  // Location / Venue
  location_address?: string;
  location_district?: string;
  location_lat?: number;
  location_lng?: number;
  venue_name?: string;
  city?: string;
  postal_code?: string;
  
  // Pricing
  price_type: PriceType;
  price_min?: number;
  price_max?: number;
  price_details?: PriceDetails;
  
  // Ticket/Booking Status
  availability_status?: AvailabilityStatus;
  registration_deadline?: string;
  
  // Age
  age_min?: number;
  age_max?: number;
  age_recommendation_text?: string;
  sibling_friendly?: boolean;
  
  // Indoor/Outdoor
  is_indoor: boolean;
  is_outdoor: boolean;
  
  // Language & Comprehension
  language?: string;
  complexity_level?: ComplexityLevel;
  
  // Stressfree Details
  noise_level?: NoiseLevel;
  has_seating?: boolean;
  typical_wait_minutes?: number;
  food_drink_allowed?: boolean;
  
  // Capacity
  capacity?: number;
  spots_limited?: boolean;
  early_arrival_hint?: string;
  
  // Series / Recurrence
  recurrence_rule?: string;
  parent_series_id?: string;
  next_occurrences?: string[];
  
  // Transit / Arrival
  transit_stop?: string;
  transit_walk_minutes?: number;
  has_parking?: boolean;
  
  // Contact
  booking_url?: string;
  contact_email?: string;
  contact_phone?: string;
  
  // Media
  image_urls?: string[];
  
  // Status
  status: EventStatus;
  is_complete: boolean;
  is_verified: boolean;
  completeness_score?: number;
  last_verified_at?: string;
  
  // AI Fields
  age_rating?: string;
  ai_summary_short?: string;
  ai_summary_highlights?: string[];
  ai_fit_blurb?: string;
  
  // Engagement
  view_count?: number;
  save_count?: number;
  
  // Relations
  categories?: CategoryRef[];
  scores?: EventScores;
  amenities?: AmenityRef[];
  provider?: ProviderRef;
  
  // Timestamps
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
  
  // Status
  is_active: boolean;
  health_status: HealthStatus;
  consecutive_failures: number;
  
  // Timestamps
  last_fetch_at?: string;
  last_success_at?: string;
  last_failure_at?: string;
  
  // Config
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
  email_verified?: boolean;
  email_verified_at?: string;
  last_login_at?: string;
  created_at: string;
  updated_at?: string;
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
  details?: Record<string, any>;
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
  
  // New filter options
  language?: string;
  noiseLevel?: NoiseLevel;
  hasSeating?: boolean;
  hasParking?: boolean;
  isRecurring?: boolean;
  availabilityStatus?: AvailabilityStatus;
  siblingFriendly?: boolean;
  
  page?: number;
  limit?: number;
  sort?: 'soonest' | 'newest' | 'relevance' | 'nearest';
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
