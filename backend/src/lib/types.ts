/**
 * Backend types and re-exports.
 * Shared types are imported directly from @prisma/client or where needed.
 */

export type { UserRole } from '@prisma/client';

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
