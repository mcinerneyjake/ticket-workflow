import { configDefaults, defineConfig } from 'vitest/config';
import { holdTestRun, TEST_RUN_GLOBAL_SETUP } from 'ticket-workflow/test-run';

// One of K machine-wide test-run slots plus a per-run TMPDIR, taken before vitest starts, so
// concurrent runs on one machine queue instead of starving each other. No-op on CI.
await holdTestRun();

export default defineConfig({
  test: {
    environment: 'node',
    // Releases the slot taken above.
    globalSetup: [TEST_RUN_GLOBAL_SETUP],
    // Extend the defaults, never replace them (they carry **/node_modules/** and **/.git/**).
    // dist/**: a local build emits compiled *.test.js that vitest would collect twice.
    // .claude/worktrees/** can hold full checkouts — same double-collection failure.
    exclude: [...configDefaults.exclude, 'dist/**', '.claude/worktrees/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'html'],
      // A floor, not a target. perFile so an untested new file can't hide behind the aggregate.
      thresholds: {
        perFile: true,
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
