/**
 * Supabase Client for Backend
 * Uses Service Role Key for admin operations and token verification
 */

import { createClient, SupabaseClient, User } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Track if Supabase is properly configured
export const isSupabaseConfigured = !!(supabaseUrl && supabaseServiceKey);

if (!isSupabaseConfigured) {
  console.warn('⚠️ Supabase environment variables not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).');
  console.warn('⚠️ OAuth/Supabase auth features will not work. Email/Password auth still works.');
}

// Service role client for admin operations
// Only create if properly configured to avoid crashes
export const supabaseAdmin: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseServiceKey!, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

/**
 * Verify a Supabase access token and return the user
 */
export async function verifyToken(token: string): Promise<User | null> {
  if (!supabaseAdmin) {
    console.error('Supabase not configured - cannot verify token');
    return null;
  }
  
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    
    if (error) {
      console.error('Token verification error:', error.message);
      return null;
    }
    
    return user;
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
}

/**
 * Get user by ID (using service role)
 */
export async function getUserById(userId: string): Promise<User | null> {
  if (!supabaseAdmin) {
    console.error('Supabase not configured - cannot get user');
    return null;
  }
  
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    
    if (error) {
      console.error('Get user by ID error:', error.message);
      return null;
    }
    
    return user;
  } catch (error) {
    console.error('Get user by ID failed:', error);
    return null;
  }
}

/**
 * Update user metadata (using service role)
 */
export async function updateUserMetadata(userId: string, metadata: Record<string, unknown>) {
  if (!supabaseAdmin) {
    throw new Error('Supabase not configured - cannot update user metadata');
  }
  
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      user_metadata: metadata,
    });
    
    if (error) {
      throw error;
    }
    
    return user;
  } catch (error) {
    console.error('Update user metadata failed:', error);
    throw error;
  }
}

/**
 * Delete a user (using service role)
 */
export async function deleteUser(userId: string) {
  if (!supabaseAdmin) {
    throw new Error('Supabase not configured - cannot delete user');
  }
  
  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    
    if (error) {
      throw error;
    }
    
    return true;
  } catch (error) {
    console.error('Delete user failed:', error);
    throw error;
  }
}
