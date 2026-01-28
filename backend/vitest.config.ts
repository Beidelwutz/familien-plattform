import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run tests in Node environment
    environment: 'node',
    
    // Enable globals for describe, it, expect, etc.
    globals: true,
    
    // Test file patterns
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    
    // Exclude patterns
    exclude: ['node_modules', 'dist'],
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        'vitest.config.ts',
        'prisma/',
      ],
    },
    
    // Setup files to run before tests
    setupFiles: ['./tests/setup.ts'],
    
    // Timeout for tests
    testTimeout: 10000,
    
    // Report slow tests
    slowTestThreshold: 1000,
  },
  
  resolve: {
    alias: {
      '@': '/src',
      '@shared': '../shared',
    },
  },
});
