/**
 * Vitest Setup File
 * This runs before all tests
 */

import { beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

// Mock console.log in tests to keep output clean (optional)
// vi.spyOn(console, 'log').mockImplementation(() => {});

// Global test setup
beforeAll(async () => {
  // Setup code that runs once before all tests
  console.log('🧪 Starting test suite...');
});

// Global test teardown
afterAll(async () => {
  // Cleanup code that runs once after all tests
  console.log('✅ Test suite completed');
});

// Clean state before each test
beforeEach(() => {
  // Reset mocks before each test
  vi.clearAllMocks();
});

// Extend expect with custom matchers if needed
// expect.extend({...});
