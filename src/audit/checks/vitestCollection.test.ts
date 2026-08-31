import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { vitestCollection } from './vitestCollection.js';
import { defaultExec, readRepoFile, type AuditContext } from '../types.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(config?: string, name = 'vitest.config.ts'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-vitest-collection-'));
  tempDirs.push(dir);
  if (config !== undefined) writeFileSync(path.join(dir, name), config);
  return dir;
}

function ctxFor(dir: string): AuditContext {
  return { repoDir: dir, read: (rel) => readRepoFile(dir, rel), exec: defaultExec };
}

function run(config?: string, name?: string) {
  return vitestCollection.run(ctxFor(makeRepo(config, name)));
}

/** A config whose test.exclude array is exactly `globs`, plus a realistic coverage block. */
function withExclude(globs: readonly string[], coverageExclude: readonly string[] = ['src/**/*.test.ts']): string {
  return `import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, ${globs.map((g) => `'${g}'`).join(', ')}],
    coverage: {
      provider: 'v8',
      exclude: [${coverageExclude.map((g) => `'${g}'`).join(', ')}],
      thresholds: { lines: 80 },
    },
  },
});
`;
}

describe('vitest-collection check — the worktree glob must reach the suites NESTED in a worktree', () => {
  it('PASSES the recursive form', () => {
    const res = run(withExclude(['dist/**', '.claude/worktrees/**']));
    expect(res.status, res.detail).toBe('pass');
  });

  it('FAILS a config that excludes other things but not the worktree directory', () => {
    const res = run(withExclude(['dist/**']));
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('.claude/worktrees/**');
  });

  // tkt-17d81c74b662 measured this exact form: `/*` matches the worktree DIRECTORY but not the
  // suites inside it, so the doubled collection survives a glob that looks present.
  it('FAILS the non-recursive `.claude/worktrees/*`, and says the form is the problem', () => {
    const res = run(withExclude(['.claude/worktrees/*']));
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(/not recursive|nested/i);
  });

  it('FAILS the bare `.claude/worktrees` with no glob at all', () => {
    const res = run(withExclude(['.claude/worktrees']));
    expect(res.status).toBe('fail');
  });

  // The shipped node template carries `// .claude/worktrees/** can hold full checkouts` as a
  // COMMENT. A check that did not strip comments would pass every repo that merely mentions it.
  it('FAILS when the glob appears only in a comment', () => {
    const res = run(`export default {
  test: {
    // .claude/worktrees/** can hold full checkouts whose suites would double-collect
    exclude: ['dist/**'],
  },
};
`);
    expect(res.status).toBe('fail');
  });

  it('FAILS when the glob appears only in a BLOCK comment', () => {
    const res = run(`export default {
  test: {
    /* excludes: '.claude/worktrees/**' one day */
    exclude: ['dist/**'],
  },
};
`);
    expect(res.status).toBe('fail');
  });

  // coverage.exclude narrows what is REPORTED on, never what is collected — so a glob there leaves
  // the doubled run fully intact.
  it('FAILS when the glob is in coverage.exclude only, not the collection exclude', () => {
    const res = run(withExclude(['dist/**'], ['src/**/*.test.ts', '.claude/worktrees/**']));
    expect(res.status).toBe('fail');
  });

  it('FAILS a config with no collection exclude at all', () => {
    const res = run(`export default { test: { environment: 'node' } };\n`);
    expect(res.status).toBe('fail');
  });

  it('FAILS a config whose collection exclude is empty', () => {
    const res = run(`export default { test: { exclude: [] } };\n`);
    expect(res.status).toBe('fail');
  });

  it('FAILS when no vitest config exists — the default collection is recursive from the root', () => {
    const res = run(undefined);
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('no vitest config');
  });

  // Mirrors the gitignore check's blanket-`.claude/` precedent: the effect this check exists for IS
  // achieved, and stricter is not a defect — but it silently drops real suites, so say so.
  it('PASSES a broader `.claude/**`, with a warning that it is over-broad', () => {
    const res = run(withExclude(['.claude/**']));
    expect(res.status).toBe('pass');
    expect(res.detail).toMatch(/broad/i);
  });

  it('accepts double and backtick quoting', () => {
    expect(run(`export default { test: { exclude: [".claude/worktrees/**"] } };\n`).status).toBe('pass');
    expect(run('export default { test: { exclude: [`.claude/worktrees/**`] } };\n').status).toBe('pass');
  });

  it('finds each config filename variant', () => {
    for (const name of ['vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs']) {
      expect(run(withExclude(['.claude/worktrees/**']), name).status, name).toBe('pass');
    }
  });

  it('BLOCKS — never passes — when the config cannot be read', () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, 'vitest.config.ts'));
    const res = vitestCollection.run(ctxFor(dir));
    expect(res.status).toBe('blocked');
  });

  // Every case below was measured PASSING — i.e. certifying a doubled run — against the first
  // implementation, which identified the collection exclude by SUBTRACTION ("any exclude not inside
  // a coverage block") and matched globs by substring. Both were fail-opens.

  it('FAILS a glob narrowed after the globstar — it excludes snapshots, not the suites', () => {
    expect(run(withExclude(['.claude/worktrees/**/*.snap'])).status).toBe('fail');
  });

  it('FAILS a glob re-rooted under another parent, which never matches the real worktree', () => {
    expect(run(withExclude(['foo/.claude/worktrees/**'])).status).toBe('fail');
  });

  it('FAILS a NEGATED worktree glob — the opposite of an exclusion', () => {
    expect(run(withExclude(['!.claude/worktrees/**'])).status).toBe('fail');
  });

  it('FAILS `.claude/**` narrowed by a suffix — it is not the over-broad case, it is a miss', () => {
    expect(run(withExclude(['.claude/**/*.md'])).status).toBe('fail');
  });

  it('PASSES a leading-globstar spelling and the trailing `/*` equivalent', () => {
    expect(run(withExclude(['**/.claude/worktrees/**'])).status).toBe('pass');
    expect(run(withExclude(['.claude/worktrees/**/*'])).status).toBe('pass');
  });

  // The collection exclude is identified POSITIVELY as a direct child of `test`, so every spelling
  // of a nested block is rejected without having to be anticipated one at a time.
  it('FAILS a QUOTED coverage key holding the glob', () => {
    const res = run(`export default { test: { exclude: ['dist/**'], "coverage": { exclude: ['.claude/worktrees/**'] } } };\n`);
    expect(res.status).toBe('fail');
  });

  it('FAILS a HOISTED coverage object holding the glob', () => {
    const res = run(`const cov = { exclude: ['.claude/worktrees/**'] };
export default { test: { exclude: ['dist/**'], coverage: cov } };
`);
    expect(res.status).toBe('fail');
  });

  it('FAILS a CALL-WRAPPED coverage object holding the glob', () => {
    const res = run(`export default { test: { exclude: ['dist/**'], coverage: makeCov({ exclude: ['.claude/worktrees/**'] }) } };\n`);
    expect(res.status).toBe('fail');
  });

  // vitest has more nested `exclude` keys than `coverage`, and none of the others govern collection.
  it('FAILS when the glob sits in test.typecheck.exclude or test.benchmark.exclude', () => {
    for (const key of ['typecheck', 'benchmark']) {
      const res = run(`export default { test: { ${key}: { exclude: ['.claude/worktrees/**'] } } };\n`);
      expect(res.status, key).toBe('fail');
    }
  });

  // A regex literal carrying an unbalanced brace closed the coverage region early under the old
  // subtraction approach, promoting the coverage exclude to a collection one.
  it('FAILS when a regex literal in a coverage block carries an unbalanced brace', () => {
    const res = run(`export default { test: { exclude: ['dist/**'], coverage: { rx: /}/, exclude: ['.claude/worktrees/**'] } } };\n`);
    expect(res.status).toBe('fail');
  });

  it('reads a quoted `test` key, and a double-quoted glob alongside a coverage block', () => {
    const res = run(`export default { "test": { exclude: ["dist/**", ".claude/worktrees/**"], coverage: { exclude: ['src/**/*.test.ts'] } } };\n`);
    expect(res.status, res.detail).toBe('pass');
  });

  it('is not fooled by a comment sitting INSIDE the exclude array', () => {
    const res = run(`export default { test: { exclude: [
      'dist/**', // .claude/worktrees/** belongs here one day
    ] } };
`);
    expect(res.status).toBe('fail');
  });

  it('is a node-tier check', () => {
    expect(vitestCollection.tier).toBe('node');
    expect(vitestCollection.id).toBe('vitest-collection');
  });
});
