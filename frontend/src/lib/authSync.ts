/**
 * Auth Synchronization Module
 * Ensures the auth_token in localStorage is synchronized with the Supabase session.
 * This prevents redirect loops when navigating directly to admin pages.
 */

import { getSession, signOut } from './supabase';

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
      let token = localStorage.getItem('auth_token');
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
 * Clear the auth token from localStorage only.
 * For full logout, use logout() instead.
 */
export function clearAuthToken(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('auth_token');
  }
  syncPromise = null;
}

/**
 * Full logout: clears localStorage and Supabase session.
 * Optionally redirects to a specified URL.
 * @param redirectUrl - URL to redirect to after logout (default: '/')
 */
export async function logout(redirectUrl: string = '/'): Promise<void> {
  if (typeof localStorage === 'undefined' || typeof window === 'undefined') {
    return;
  }

  try {
    // Clear localStorage token
    localStorage.removeItem('auth_token');
    syncPromise = null;

    // Sign out from Supabase (clears session)
    await signOut();
  } catch (error) {
    console.error('Logout error:', error);
    // Still clear local token even if Supabase signout fails
    localStorage.removeItem('auth_token');
  }

  // Redirect
  if (redirectUrl) {
    window.location.href = redirectUrl;
  }
}

/**
 * Check if user is currently authenticated.
 * Does not verify the token, just checks if one exists.
 */
export function isAuthenticated(): boolean {
  if (typeof localStorage === 'undefined') {
    return false;
  }
  return !!localStorage.getItem('auth_token');
}

// Auto-sync on module load (for pages that import this module)
if (typeof window !== 'undefined') {
  // Run sync after a small delay to ensure Supabase client is initialized
  setTimeout(() => {
    syncAuthToken().catch(console.error);
  }, 100);
}
