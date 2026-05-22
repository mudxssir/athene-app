import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['lib/**'],
      exclude: ['lib/**/__tests__/**', 'lib/**/*.test.ts', 'lib/**/*.d.ts', 'lib/**/*.md'],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 38,
        statements: 48,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      'server-only': path.resolve(__dirname, './__tests__/mocks/server-only.ts'),
    },
  },
});
