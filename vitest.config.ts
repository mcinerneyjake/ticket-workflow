import { configDefaults, defineConfig } from 'vitest/config';
import { holdTestRun } from './src/test-run/hold.js';

// One of K machine-wide test-run slots, and a per-run TMPDIR, taken at config resolution so a
// refused run has touched nothing (tkt-14788b3fc356). Released by src/test-run/globalSetup.ts.
// No-op inside workers (vitest.config.test.ts imports this file from one) and on CI.
await holdTestRun({ repo: 'ticket-workflow' });

export default defineConfig({
  test: {
    environment: 'node',
    // Silences the service logger by default; see the file for why and how a test opts out.
    setupFiles: ['src/test-support/silenceLogger.ts'],
    // Releases the slot and TMPDIR above. Only the release lives here — see holdTestRun.
    globalSetup: ['./src/test-run/globalSetup.ts'],
    // Default glob picks up src/**/*.test.ts AND hooks/**/*.test.mjs. Extend the defaults rather
    // than replace them; .claude/worktrees/ can hold full second checkouts whose suites would
    // double-collect.
    exclude: [...configDefaults.exclude, 'dist/**', '.claude/worktrees/**'],
    // ONE worker, deliberately. Most suites here reach a `child_process` spawn — directly, or
    // through `defaultExec` in `src/audit/types.ts` — and concurrent spawn-heavy files starve each
    // other past `testTimeout` while the machine looks idle. Measured solo on 14 cores, same
    // commit (tkt-2eb570851bad): 13 workers -> 20 failures; 3 -> 1; 2 -> 1 on a DIFFERENT test;
    // 1 -> 0. Every failure was a 20s timeout or a `probeMcp` budget expiry, never an assertion,
    // and each victim passed alone.
    //
    // The moving victim at 2 and 3 is why this is 1 and not a tuned number: any co-running worker
    // inflates `src/audit/audit.test.ts` (104s alone, 173s at 3) past the timeout. At 1 no two
    // FILES overlap — but note `maxWorkers` bounds files, not tests within one, so an
    // `it.concurrent` in a spawn-heavy suite would reintroduce the overlap. None uses it today.
    //
    // Unconditional, deliberately: CI's only test leg, the husky pre-commit hook and watch mode all
    // serialize too. One code path beats a `process.env.CI` branch that no local run exercises.
    // Costs ~46s of wall clock here (238s vs 192s, against a baseline that was RED). The gain is
    // not fewer CPU-seconds — roughly the same work spread wider — it is holding ONE core instead
    // of 13, which is what stops a run here starving the other agent sessions on this machine.
    // Raising `testTimeout` instead would mask the contention rather than remove it.
    maxWorkers: 1,
    // The audit/init suites spawn real subprocesses (the repo's own tsc, git); under a loaded
    // machine a multi-audit test measured >5s purely from contention, failing as a timeout while
    // passing in isolation — a false negative about the code. 20s still catches a genuine hang.
    // Raising it further would mask oversubscription rather than fix it; maxWorkers is the lever.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // mcp/server.ts is a thin stdio-transport entrypoint with no logic (same exclusion its
      // consumer applies); index.ts stays IN — the export-surface test executes the barrel.
      exclude: [
        'src/**/*.test.ts',
        'src/test-support/**',
        'src/mcp/server.ts',
        // Runs in vitest's main process, which v8 never instruments, and is branchless; the
        // release it returns lives in hold.ts, which is measured.
        'src/test-run/globalSetup.ts',
      ],
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
