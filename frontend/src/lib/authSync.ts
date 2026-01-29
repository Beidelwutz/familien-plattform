/**
 * Auth Synchronization Module
 * Ensures the auth_token in localStorage is synchronized with the Supabase session.
 * This prevents redirect loops when navigating directly to admin pages.
 */

import { getSession } from './supabase';

let syncPromise: Promise<string | null> | null = null;

/**
 * Synchronize auth token from Supabase session to localStorage.
 * Returns the token if successful, null otherwise.
 * This function is idempotent and can be called multiple times.
 */
export async function syncAuthToken(): Promise<string | null> {
  // Return existing promise if already syncing
  if (syncPromise) {
    return syncPromise;
  }

  syncPromise = (async () => {
    if (typeof localStorage === 'undefined' || typeof window === 'undefined') {
      return null;
    }

    try {
      // Check if we already have a token
      let token = localStorage.getItem('auth_token');
      
      // If we have a token, check if it's still valid by verifying Supabase session
      const session = await getSession();
      
      if (session?.access_token) {
        // Session exists - update token if different or missing
        if (token !== session.access_token) {
          localStorage.setItem('auth_token', session.access_token);
          token = session.access_token;
        }
      } else if (token) {
        // No session but we have a token - it might be stale
        // Keep the token for now, API will reject if invalid
      }
      
      return token;
    } catch (error) {
      console.error('Auth sync error:', error);
      return localStorage.getItem('auth_token');
    }
  })();

  return syncPromise;
}

/**
 * Get the current auth token, syncing from Supabase if necessary.
 * This is the recommended way to get the token for API calls.
 */
export async function getAuthToken(): Promise<string | null> {
  return syncAuthToken();
}

/**
 * Clear the auth token and Supabase session.
 */
export function clearAuthToken(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('auth_token');
  }
  syncPromise = null;
}

// Auto-sync on module load (for pages that import this module)
if (typeof window !== 'undefined') {
  // Run sync after a small delay to ensure Supabase client is initialized
  setTimeout(() => {
    syncAuthToken().catch(console.error);
  }, 100);
}
