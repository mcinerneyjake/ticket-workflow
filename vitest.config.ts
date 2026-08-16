import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Default glob picks up src/**/*.test.ts AND hooks/**/*.test.mjs.
    exclude: ['node_modules/**', 'dist/**'],
    // The audit/init suites spawn real subprocesses (the repo's own tsc, git); under a loaded
    // machine a multi-audit test measured >5s purely from contention, failing as a timeout while
    // passing in isolation — a false negative about the code. 20s still catches a genuine hang.
    testTimeout: 20_000,
  },
});
