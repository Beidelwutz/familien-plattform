/**
 * Admin API Client
 * Robust fetch wrapper with auth handling, query params, and error management
 */

const API_URL = import.meta.env.PUBLIC_API_URL || 'http://localhost:4000';

interface FetchOptions extends Omit<RequestInit, 'body'> {
  params?: Record<string, string | number | boolean | undefined | null>;
  body?: any;
}

export class AdminApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

/**
 * Core fetch function with authentication and error handling
 */
export async function adminFetch<T = any>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const token = typeof localStorage !== 'undefined' 
    ? localStorage.getItem('auth_token') 
    : null;

  // Build URL with query params
  let url = `${API_URL}${endpoint}`;
  if (options.params) {
    const searchParams = new URLSearchParams();
    Object.entries(options.params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    });
    const queryString = searchParams.toString();
    if (queryString) {
      url += '?' + queryString;
    }
  }

  // Prepare headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Make request
  const res = await fetch(url, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'include', // For future cookie migration
  });

  // Handle auth errors -> redirect to login
  if (res.status === 401 || res.status === 403) {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('auth_token');
    }
    if (typeof window !== 'undefined') {
      window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
    }
    throw new AdminApiError(res.status, 'Unauthorized', 'UNAUTHORIZED');
  }

  // Handle 204 No Content
  if (res.status === 204) {
    return {} as T;
  }

  // Parse JSON response
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new AdminApiError(res.status, 'Invalid JSON response', 'PARSE_ERROR');
  }

  // Handle API errors
  if (!res.ok) {
    throw new AdminApiError(
      res.status,
      data.message || data.error || 'API Error',
      data.code
    );
  }

  return data;
}

/**
 * Convenience API methods
 */
export const adminApi = {
  get: <T = any>(endpoint: string, params?: Record<string, any>) =>
    adminFetch<T>(endpoint, { method: 'GET', params }),

  post: <T = any>(endpoint: string, body?: any) =>
    adminFetch<T>(endpoint, { method: 'POST', body }),

  put: <T = any>(endpoint: string, body?: any) =>
    adminFetch<T>(endpoint, { method: 'PUT', body }),

  patch: <T = any>(endpoint: string, body?: any) =>
    adminFetch<T>(endpoint, { method: 'PATCH', body }),

  delete: <T = any>(endpoint: string) =>
    adminFetch<T>(endpoint, { method: 'DELETE' }),
};

/**
 * Type definitions for API responses
 */
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}

export interface AdminStats {
  events: {
    total: number;
    published: number;
    pending_review: number;
    today_imports: number;
  };
  sources: {
    healthy: number;
    degraded: number;
    failing: number;
    dead: number;
    unknown: number;
  };
}

export interface ReviewEvent {
  id: string;
  title: string;
  description_short?: string;
  start_datetime: string;
  end_datetime?: string;
  location_address?: string;
  status: string;
  completeness_score?: number;
  created_at: string;
  scores?: {
    relevance_score?: number;
    quality_score?: number;
    family_fit_score?: number;
  };
  primary_source?: {
    source?: {
      name: string;
      type: string;
    };
  };
}

export interface Source {
  id: string;
  name: string;
  type: string;
  url?: string;
  is_active: boolean;
  health_status: string;
  last_fetch_at?: string;
  last_success_at?: string;
  last_failure_at?: string;
  consecutive_failures: number;
  avg_events_per_fetch?: number;
}

export interface DupCandidate {
  id: string;
  event_a_id: string;
  event_b_id: string;
  confidence: 'exact' | 'likely' | 'maybe';
  score?: number;
  detected_at: string;
  event_a: {
    id: string;
    title: string;
    start_datetime: string;
    location_address?: string;
  };
  event_b: {
    id: string;
    title: string;
    start_datetime: string;
    location_address?: string;
  };
}

export interface IngestRun {
  id: string;
  correlation_id: string;
  source_id?: string;
  started_at: string;
  finished_at?: string;
  status: 'running' | 'success' | 'partial' | 'failed';
  events_found: number;
  events_created: number;
  events_updated: number;
  events_skipped: number;
  /** Anzahl Events, die bereits existierten und unverändert blieben */
  events_unchanged?: number;
  /** Anzahl Events, die ignoriert wurden (z. B. Filter, Priorität) */
  events_ignored?: number;
  error_message?: string;
  needs_attention: boolean;
  source?: {
    id: string;
    name: string;
    type: string;
  };
}
