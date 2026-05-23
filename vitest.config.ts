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
      exclude: ['lib/**/__tests__/**', 'lib/**/*.test.ts', 'lib/**/*.d.ts', 'lib/**/*.md', 'lib/scripts/**', 'lib/**/*.gitkeep'],
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
      // server-only is resolved by Next.js webpack but not by Vitest — stub with a no-op.
      // Both lib/__mocks__/ (local) and __tests__/mocks/ (remote) contain the stub;
      // __tests__/mocks/ is used here to align with the remote integration test suite.
      'server-only': path.resolve(__dirname, './__tests__/mocks/server-only.ts'),
    },
  },
});
