import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

// End to end through THIS repo's vitest.config.ts: the per-run TMPDIR that holdTestRun set at config
// time must be what a worker's os.tmpdir() answers, or every mkdtemp in the suite still lands in the
// shared machine tmpdir. On CI the helper skips itself, and this asserts that branch too.

const skippedOnCi = process.env.CI !== undefined && process.env.CI !== '' && process.env.TEST_SLOTS_FORCE !== '1';

describe('the per-run TMPDIR reaches vitest workers', () => {
  it('os.tmpdir() inside a worker is the run dir, except where the helper is skipped on CI', () => {
    const inRunDir = /\/ticket-workflow-test\/run-\d+-[a-z0-9]+$/.test(tmpdir());
    expect(inRunDir).toBe(!skippedOnCi);
  });
});
