import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Default glob picks up src/**/*.test.ts AND hooks/**/*.test.mjs. Extend the defaults rather
    // than replace them; .claude/worktrees/ can hold full second checkouts whose suites would
    // double-collect.
    exclude: [...configDefaults.exclude, 'dist/**', '.claude/worktrees/**'],
    // The audit/init suites spawn real subprocesses (the repo's own tsc, git); under a loaded
    // machine a multi-audit test measured >5s purely from contention, failing as a timeout while
    // passing in isolation — a false negative about the code. 20s still catches a genuine hang.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // mcp/server.ts is a thin stdio-transport entrypoint with no logic (same exclusion its
      // consumer applies); index.ts stays IN — the export-surface test executes the barrel.
      exclude: ['src/**/*.test.ts', 'src/test-support/**', 'src/mcp/server.ts'],
      reporter: ['text'],
      // A floor, not a target: per-file so an untested new file can't hide behind the aggregate.
      // Branches start at 40 — the shortfall is concentrated in error-path guards (EISDIR/EACCES
      // arms) across the audit checks; ratchet upward as those gain fixtures.
      thresholds: {
        perFile: true,
        lines: 80,
        functions: 80,
        branches: 40,
        statements: 70,
      },
    },
  },
});
