import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { vitestCoverage } from './vitestCoverage.js';
import { defaultExec, readRepoFile, type AuditContext } from '../types.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(config: string, name = 'vite.config.ts') {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-vitest-coverage-'));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, name), config);
  const ctx: AuditContext = { repoDir: dir, read: (rel) => readRepoFile(dir, rel), exec: defaultExec };
  return vitestCoverage.run(ctx);
}

/**
 * This check now reads `vite.config.ts`, a file class that routinely carries `//` inside strings
 * (proxy targets, docs URLs) and `/*` inside globs. The regex comment-stripping it used to do
 * deleted from such a `//` to end of line — taking the brace that closed `thresholds` with it —
 * after which a trailing-`}` search ran on into the next block and read an unrelated digit as a
 * coverage floor.
 */
describe('vitest-coverage — thresholds delimited structurally (tkt-5c0e00fae59d review)', () => {
  it('does not read a later digit as a floor when a string contains `//`', () => {
    const res = run(`export default {
  test: {
    coverage: {
      thresholds: { lines: 0, docs: 'https://example.com/x' },
    },
    testTimeout: 20000,
  },
};
`);
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('no non-zero floor');
  });

  it('does not count a digit inside a string as a floor', () => {
    const res = run(`export default {
  test: { coverage: { thresholds: { lines: 0, note: 'raise to 80 later' } } },
};
`);
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('no non-zero floor');
  });

  it('PASSES a real non-zero floor even beside a `//`-bearing string', () => {
    const res = run(`export default {
  test: {
    coverage: {
      // see https://vitest.dev/config for the shape
      thresholds: { lines: 80 },
    },
  },
};
`);
    expect(res.status, res.detail).toBe('pass');
  });

  it('FAILS when there is no thresholds block at all', () => {
    const res = run(`export default { test: { coverage: { provider: 'v8' } } };\n`);
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('no coverage thresholds');
  });

  it('BLOCKED on an unclosed brace rather than guessing the extent', () => {
    const res = run(`export default { test: { coverage: { thresholds: { lines: 80 };\n`);
    expect(res.status, res.detail).toBe('blocked');
  });
});

describe('vitest-coverage — coverage resolved through the test block only', () => {
  // The same depth-blind fail-open that `directChildOnly` closed for `test`: an unrelated nested
  // `coverage` outranked the real block and certified a gate whose only floor is 0.
  it('does not let a nested `coverage` outrank the real test.coverage block', () => {
    const res = run(`export default {
  build: { rollupOptions: { coverage: { thresholds: { lines: 80 } } } },
  test: { coverage: { thresholds: { lines: 0 } } },
};
`);
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('no non-zero floor');
  });

  it('does not let a top-level `coverage` outrank it either', () => {
    const res = run(`const coverage = { thresholds: { lines: 90 } };
export default { test: { coverage: { thresholds: { lines: 0 } } } };
`);
    expect(res.status, res.detail).toBe('fail');
  });
});
