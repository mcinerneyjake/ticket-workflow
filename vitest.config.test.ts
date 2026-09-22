import { describe, expect, it } from 'vitest';
import config from './vitest.config.js';

const setupFilesOf = (): readonly string[] => {
  const declared = config.test?.setupFiles;
  if (typeof declared === 'string') return [declared];
  return declared ?? [];
};

describe('the vitest config keeps the settings the serial cap depends on', () => {
  // Every assertion below reads `config.test`, so its absence would make them all pass vacuously —
  // `?.` yields undefined and `?? {}` yields an empty object, both of which read as clean. Fail
  // that case loudly instead, here, once.
  it('declares a test block at all', () => {
    expect(config.test).toBeDefined();
  });

  // Measured solo on the same commit (tkt-2eb570851bad): 13 workers -> 20 failures, 3 -> 1, 2 -> 1
  // on a different test, 1 -> 0. Any width above 1 lets two spawn-heavy files overlap, which is the
  // mechanism; a number chosen to pass on the day would be fitted to load, not to the cause.
  it('pins maxWorkers to exactly 1', () => {
    expect(config.test?.maxWorkers).toBe(1);
  });

  it('does not reach one worker via fileParallelism instead', () => {
    // `fileParallelism: false` also forces one worker (vitest documents it as overriding
    // maxWorkers), but measured 330s against 223s for the maxWorkers spelling — on an EARLIER
    // commit than the 238s above, so those two figures are not comparable to each other.
    // Asserted as `not.toBe(false)` rather than `toBeUndefined()`: an explicit `true` is the
    // default and harmless, so failing it would be a false positive.
    expect(config.test?.fileParallelism).not.toBe(false);
  });

  it('keeps testTimeout at 20s — raising it would mask contention rather than remove it', () => {
    // The serial cap removes the overlap behind every observed timeout, so this budget is back to
    // its real job: catching a genuine hang. Raising it would hide a future regression, because a
    // contended test gets slower long before it fails.
    expect(config.test?.testTimeout).toBe(20_000);
  });

  it('still excludes worktree checkouts from collection', () => {
    // NOTE what this does and does not pin. It reads the RESOLVED array, so it proves the glob is
    // in effect — it cannot see whether the glob is spelled as a literal. The `vitest-collection`
    // audit check parses this file as source text and harvests only string literals inside the
    // `exclude` brackets, so hoisting the glob to a named const leaves this test green and fails
    // `audit .` (verified). CI's `audit .` step is what guards the spelling; this guards presence.
    expect(config.test?.exclude ?? []).toContain('.claude/worktrees/**');
  });

  it('still declares the logger-silencing setup file', () => {
    expect(setupFilesOf()).toContain('src/test-support/silenceLogger.ts');
  });

  it('declares no `projects`, which would silently drop setupFiles and testTimeout', () => {
    // Vitest projects do NOT inherit the root `test` block: hardpack measured setupFiles not
    // running (`setup 0ms`) and testTimeout reverting to the 5s default under a split
    // (tkt-d5957c036ff8). `maxWorkers` is the exception and survives — `resolveMaxWorkers` falls
    // back to `project.vitest.config.maxWorkers`, the root config — so only those two are at risk.
    // Splitting is allowed; this is the reminder that each project must restate them.
    expect(Object.keys(config.test ?? {})).not.toContain('projects');
  });
});
