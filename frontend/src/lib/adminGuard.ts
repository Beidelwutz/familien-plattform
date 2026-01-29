/**
 * Admin Guard Helper
 * Central authentication and authorization check for admin pages
 */

import { adminApi, type ApiResponse } from './adminApi';
import { getSession } from './supabase';

export interface User {
  id: string;
  email: string;
  role: 'parent' | 'provider' | 'admin';
  created_at: string;
}

/**
 * Synchronize auth token from Supabase session to localStorage
 * This ensures the token is available even when navigating directly to admin pages
 */
async function syncAuthToken(): Promise<string | null> {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  let token = localStorage.getItem('auth_token');
  
  // Wenn kein Token im localStorage, versuche Supabase-Session
  if (!token) {
    try {
      const session = await getSession();
      if (session?.access_token) {
        token = session.access_token;
        localStorage.setItem('auth_token', token);
      }
    } catch (e) {
      console.error('Error syncing auth token from Supabase:', e);
    }
  }
  
  return token;
}

/**
 * Require admin role - redirects to login if not authenticated or not admin
 * Call this at the start of any admin page script
 */
export async function requireAdmin(): Promise<User> {
  // Sync token from Supabase session if needed
  const token = await syncAuthToken();

  if (!token) {
    redirectToLogin();
    throw new Error('No authentication token');
  }

  try {
    // Verify token and get user info
    const response = await adminApi.get<ApiResponse<User>>('/api/auth/me');
    const user = response.data;

    // Check admin role
    if (user.role !== 'admin') {
      redirectToHome('not_admin');
      throw new Error('Admin role required');
    }

    return user;
  } catch (error) {
    // Token might be expired - try refreshing from Supabase
    try {
      const session = await getSession();
      if (session?.access_token && typeof localStorage !== 'undefined') {
        localStorage.setItem('auth_token', session.access_token);
        // Retry with new token
        const response = await adminApi.get<ApiResponse<User>>('/api/auth/me');
        const user = response.data;
        if (user.role !== 'admin') {
          redirectToHome('not_admin');
          throw new Error('Admin role required');
        }
        return user;
      }
    } catch {
      // Fallback to original error handling
    }
    // adminApi handles 401/403 redirects
    throw error;
  }
}

/**
 * Check if user is authenticated (any role)
 */
export async function requireAuth(): Promise<User> {
  // Sync token from Supabase session if needed
  const token = await syncAuthToken();

  if (!token) {
    redirectToLogin();
    throw new Error('No authentication token');
  }

  try {
    const response = await adminApi.get<ApiResponse<User>>('/api/auth/me');
    return response.data;
  } catch (error) {
    throw error;
  }
}

/**
 * Get current user without redirecting (returns null if not authenticated)
 */
export async function getCurrentUser(): Promise<User | null> {
  // Sync token from Supabase session if needed
  const token = await syncAuthToken();

  if (!token) {
    return null;
  }

  try {
    const response = await adminApi.get<ApiResponse<User>>('/api/auth/me');
    return response.data;
  } catch {
    return null;
  }
}

/**
 * Check if current user is admin (without redirecting)
 */
export async function isAdmin(): Promise<boolean> {
  const user = await getCurrentUser();
  return user?.role === 'admin';
}

/**
 * Logout - clear token and redirect
 */
export function logout(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('auth_token');
  }
  if (typeof window !== 'undefined') {
    window.location.href = '/login';
  }
}

// Helper functions
function redirectToLogin(): void {
  if (typeof window !== 'undefined') {
    const currentPath = window.location.pathname;
    window.location.href = '/login?redirect=' + encodeURIComponent(currentPath);
  }
}

function redirectToHome(error?: string): void {
  if (typeof window !== 'undefined') {
    const url = error ? `/?error=${encodeURIComponent(error)}` : '/';
    window.location.href = url;
  }
}
