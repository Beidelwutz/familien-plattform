/**
 * Re-export shared types for use throughout the backend
 * This allows easy imports and provides a single source of truth
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
} from '../../shared/types/index.js';

// Re-export JwtPayload from auth middleware for convenience
export type { JwtPayload } from '../middleware/auth.js';

// Backend-specific extensions
export interface EventWithDistance {
  id: string;
  title: string;
  distance_km?: number;
  [key: string]: any;
}

export interface IngestRequestBody {
  source_id: string;
  events: Partial<Event>[];
}

export interface BatchIngestResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  results: {
    event_id?: string;
    status: 'created' | 'updated' | 'skipped' | 'error';
    message?: string;
  }[];
}
