import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
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
