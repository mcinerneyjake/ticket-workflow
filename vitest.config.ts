import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Default glob picks up src/**/*.test.ts AND hooks/**/*.test.mjs.
    exclude: ['node_modules/**', 'dist/**'],
  },
});
