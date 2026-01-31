/**
 * Supabase Client for Frontend
 * Used for authentication (Google OAuth, Email/Password)
 */

import { createClient } from '@supabase/supabase-js';

// Production: always use nsrfzjxrtlrujxgixmdr (env may be stale in Vercel)
const supabaseUrl = import.meta.env.PROD
  ? 'https://nsrfzjxrtlrujxgixmdr.supabase.co'
  : (import.meta.env.PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co');
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || 'placeholder-key';

// Track if Supabase is properly configured
export const isSupabaseConfigured = !!(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-key',
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  }
);

/**
 * Helper to check if Supabase is configured before auth operations
 */
function checkSupabaseConfig() {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase ist nicht konfiguriert. Bitte kontaktiere den Administrator.');
  }
}

/**
 * Get the OAuth callback URL for this application.
 * Used for Google OAuth and other OAuth providers.
 * This URL must be registered in:
 * - Supabase Dashboard → Authentication → URL Configuration → Redirect URLs
 * - Google Cloud Console → Credentials → OAuth Client → Authorized redirect URIs 
 *   (use the Supabase callback URL: https://<PROJECT_REF>.supabase.co/auth/v1/callback)
 */
export function getAuthCallbackUrl(): string {
  if (typeof window === 'undefined') {
    // SSR fallback - should not be used in production
    return '/auth/callback';
  }
  return `${window.location.origin}/auth/callback`;
}

/**
 * Get the password reset callback URL
 */
export function getPasswordResetUrl(): string {
  if (typeof window === 'undefined') {
    return '/passwort-reset';
  }
  return `${window.location.origin}/passwort-reset`;
}

/**
 * Get the current session
 * Also syncs the access_token to localStorage for backward compatibility
 */
export async function getSession() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) {
    return null;
  }
  
  // Sync access_token to localStorage for pages that use it directly
  if (session?.access_token && typeof localStorage !== 'undefined') {
    const currentToken = localStorage.getItem('auth_token');
    if (currentToken !== session.access_token) {
      localStorage.setItem('auth_token', session.access_token);
    }
  }
  
  return session;
}

/**
 * Get the current user
 */
export async function getUser() {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) {
    return null;
  }
  return user;
}

/**
 * Sign in with Google OAuth
 */
export async function signInWithGoogle(redirectTo?: string) {
  checkSupabaseConfig();
  
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: redirectTo || getAuthCallbackUrl(),
    },
  });
  
  if (error) {
    throw error;
  }
  
  return data;
}

/**
 * Sign in with email and password
 */
export async function signInWithEmail(email: string, password: string) {
  checkSupabaseConfig();
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  
  if (error) {
    throw error;
  }
  
  return data;
}

/**
 * Sign up with email and password
 */
export async function signUpWithEmail(email: string, password: string, metadata?: Record<string, unknown>) {
  checkSupabaseConfig();
  
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: metadata,
    },
  });
  
  if (error) {
    throw error;
  }
  
  return data;
}

/**
 * Sign out
 */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) {
    throw error;
  }
}

/**
 * Send password reset email
 */
export async function resetPassword(email: string) {
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: getPasswordResetUrl(),
  });
  
  if (error) {
    throw error;
  }
  
  return data;
}

/**
 * Update user password (after reset)
 */
export async function updatePassword(newPassword: string) {
  const { data, error } = await supabase.auth.updateUser({
    password: newPassword,
  });
  
  if (error) {
    throw error;
  }
  
  return data;
}

/**
 * Get access token for API calls
 */
export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session?.access_token || null;
}
