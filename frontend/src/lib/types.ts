/**
 * Shared types for the Frontend
 * Re-exports from the shared package for easy imports
 */

// Re-export all types from the shared package
export type {
  // Enums
  EventStatus,
  PriceType,
  SourceType,
  HealthStatus,
  ProviderType,
  SubscriptionTier,
  UserRole,
  SlotType,
  
  // Core types
  Event,
  EventScores,
  CategoryRef,
  Category,
  AmenityRef,
  Amenity,
  ProviderRef,
  
  // Source types
  Source,
  SourceFetchLog,
  
  // User types
  User,
  FamilyProfile,
  ChildInfo,
  
  // Plan types
  Plan,
  PlanSlot,
  
  // API types
  ApiResponse,
  ApiError,
  PaginatedResponse,
  
  // Search/Filter types
  EventSearchParams,
  PlanRequest,
} from '@shared/types/index';

// Frontend-specific types

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
