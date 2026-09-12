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

/** A repo assembled file-by-file, for the shapes where the config is not at `<root>/vitest.config.ts`. */
function makeRepoWith(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-vitest-collection-'));
  tempDirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

function runIn(files: Readonly<Record<string, string>>) {
  return vitestCollection.run(ctxFor(makeRepoWith(files)));
}

describe('vitest-collection — finding the config where it actually lives (tkt-5c0e00fae59d)', () => {
  it('reads a vite.config.ts carrying a test block', () => {
    const res = runIn({ 'vite.config.ts': withExclude(['dist/**', '.claude/worktrees/**']) });
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).toContain('vite.config.ts');
  });

  // The verdict is unchanged; the DIAGNOSIS is the defect. "no vitest config found" sends someone
  // to write a file that is already there, which is what makes the noise unactionable.
  it('FAILS a vite.config.ts on the merits, not for being absent', () => {
    const res = runIn({ 'vite.config.ts': withExclude(['dist/**']) });
    expect(res.status).toBe('fail');
    expect(res.detail).not.toContain('no vitest config found');
    expect(res.detail).toContain('.claude/worktrees/**');
  });

  it('prefers a dedicated vitest.config.ts over a vite.config.ts', () => {
    const res = runIn({
      'vitest.config.ts': withExclude(['dist/**', '.claude/worktrees/**']),
      'vite.config.ts': withExclude(['dist/**']),
    });
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).toContain('vitest.config.ts');
  });

  // Being a vite config is not being a vitest config: accepting one with no `test` block would
  // silently reclassify every plain vite repo as configured.
  it('does NOT accept a vite.config.ts with no test block', () => {
    const res = runIn({ 'vite.config.ts': `export default { plugins: [], build: { target: 'es2022' } };\n` });
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('no vitest config found');
  });

  it('follows an `npm --prefix <dir>` delegation in the root test script', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix server run test' } }),
      'server/vitest.config.ts': withExclude(['dist/**', '.claude/worktrees/**']),
    });
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).toContain('server/vitest.config.ts');
  });

  it('follows the `--prefix=<dir>` spelling too', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix=packages/api run test' } }),
      'packages/api/vite.config.ts': withExclude(['dist/**', '.claude/worktrees/**']),
    });
    expect(res.status, res.detail).toBe('pass');
  });

  // Both bounds are tested against a target that REALLY EXISTS and really conforms. A fixture
  // without one passes whether the bound is there or not — the escaping path simply resolves to
  // nothing — so it certifies the guard while asserting only that a missing file is missing.
  it('ignores a delegated path that escapes the repo', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'tw-vitest-escape-'));
    tempDirs.push(base);
    mkdirSync(path.join(base, 'elsewhere'), { recursive: true });
    writeFileSync(path.join(base, 'elsewhere', 'vitest.config.ts'), withExclude(['dist/**', '.claude/worktrees/**']));
    const repo = path.join(base, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'npm --prefix ../elsewhere run test' } }));
    const res = vitestCollection.run(ctxFor(repo));
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('no vitest config found');
  });

  it('ignores an absolute delegated path', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix /etc run test' } }),
      // `path.join` folds a leading slash back INSIDE the repo, so this is the file an unbounded
      // resolver would land on and report as the repo's own configuration.
      'etc/vitest.config.ts': withExclude(['dist/**', '.claude/worktrees/**']),
    });
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('no vitest config found');
  });

  it('survives an unparseable package.json rather than crashing the check', () => {
    const res = runIn({ 'package.json': '{ not json', 'vite.config.ts': withExclude(['dist/**', '.claude/worktrees/**']) });
    expect(res.status, res.detail).toBe('pass');
  });

  // A delegated config sets vitest's root to its OWN directory, so the repo-root worktree tree is
  // not merely un-excluded — it is outside collection entirely, and demanding a root-relative
  // `.claude/worktrees/**` there asks for a glob that could never match.
  it('PASSES a delegated config without the worktree glob, because that tree is outside its root', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix server run test' } }),
      'server/vitest.config.ts': withExclude(['dist/**']),
    });
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).toContain('server');
  });

  // Reading one root and reporting on the whole repo is the fail-open: both of these previously
  // FAILED, and answering from a single arbitrary root would turn them into a PASS.
  it('BLOCKED when the root test script drives two delegated roots', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix a run test && npm --prefix b run test' } }),
      'a/vitest.config.ts': withExclude(['dist/**', '.claude/worktrees/**']),
      'b/vitest.config.ts': withExclude(['dist/**', '.claude/worktrees/**']),
    });
    expect(res.status, res.detail).toBe('blocked');
  });

  it('BLOCKED when the root runs vitest directly AND delegates', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run && npm --prefix e2e run test' } }),
      'e2e/vitest.config.ts': withExclude(['dist/**', '.claude/worktrees/**']),
    });
    expect(res.status, res.detail).toBe('blocked');
  });

  // An unactionable BLOCK is the noise this ticket exists to remove: a --prefix token naming a
  // file yields ENOTDIR, which must read as "no config there", not as "the audit broke".
  it('does not BLOCK when a --prefix token names a file rather than a directory', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix notes.txt run test' } }),
      'notes.txt': 'not a directory\n',
    });
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('no vitest config found');
  });
});

/**
 * Review findings on the first cut of this ticket. Every case here was observed red against that
 * cut: each is a verdict the resolver gave that the repo's real configuration contradicts.
 */
describe('vitest-collection — resolver fail-opens and false failures (tkt-5c0e00fae59d review)', () => {
  // `.` IS the repo root, so `nested` was asserting that .claude/worktrees sits outside a
  // collection root that is exactly the repo root — and PASSING a config that excludes nothing.
  it('does not read `--prefix .` as a nested root', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix . run test:unit' } }),
      'vitest.config.ts': withExclude(['dist/**']),
    });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).not.toContain('outside its collection root');
  });

  it('does not read `--prefix ./` as a nested root either', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix ./ run test:unit' } }),
      'vitest.config.ts': withExclude(['dist/**']),
    });
    expect(res.status, res.detail).toBe('fail');
  });

  // A mis-captured --prefix suppressed the root candidates entirely, reporting "no vitest config
  // found" for a repo holding a conforming one — the exact false failure this ticket removes.
  it('still searches the root when --prefix carries no argument', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix= run test' } }),
      'vitest.config.ts': withExclude(['.claude/worktrees/**']),
    });
    expect(res.status, res.detail).toBe('pass');
  });

  it('still searches the root when the --prefix argument is an unexpanded variable', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix "$DIR" run test' } }),
      'vitest.config.ts': withExclude(['.claude/worktrees/**']),
    });
    expect(res.status, res.detail).toBe('pass');
  });

  it('still searches the root when the delegated directory is not there', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix nosuchdir run test' } }),
      'vitest.config.ts': withExclude(['.claude/worktrees/**']),
    });
    expect(res.status, res.detail).toBe('pass');
  });

  // A depth-blind scan adopted any `test` object anywhere as the vitest block, so an unrelated one
  // carrying the glob certified a repo whose real config excludes nothing.
  it('does not adopt a `test` object nested under another key', () => {
    const res = runIn({
      'vite.config.ts': `export default { build: { rollupOptions: { test: { exclude: ['.claude/worktrees/**'] } } } };\n`,
    });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('no vitest config found');
  });

  it('does not read a ternary branch as a `test` key', () => {
    const res = runIn({
      'vite.config.ts': `const x = 1;\nexport default { name: x ? 'test' : { exclude: ['.claude/worktrees/**'] } };\n`,
    });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('no vitest config found');
  });

  // The nested PASS asserted the worktree tree was outside the collection root without ever reading
  // the config's own `root`, which is exactly what moves it.
  it('BLOCKED when a delegated config moves its own root', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix server run test' } }),
      'server/vitest.config.ts': `export default { root: '..', test: { exclude: ['dist/**'] } };\n`,
    });
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toContain('root');
  });

  // The filename must sit in its own SEGMENT: a segment carrying --prefix never reaches the
  // direct-vitest test at all, so putting it beside the prefix exercises nothing.
  it('a `vitest.…` FILENAME in a later segment is not a second vitest root', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix server run test && cat vitest.ci.config.ts' } }),
      'server/vitest.config.ts': `export default { test: { exclude: ['dist/**'] } };\n`,
    });
    expect(res.status, res.detail).not.toBe('blocked');
  });

  it('does not split a quoted `|` into a second command', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: "npm --prefix server run test -- --reporter='a|vitest run'" } }),
      'server/vitest.config.ts': `export default { test: { exclude: ['dist/**'] } };\n`,
    });
    expect(res.status, res.detail).not.toBe('blocked');
  });

  // Widening an unclosed body to end-of-file let an `exclude` from outside the block read as a
  // direct child of it. "Could not delimit" is not "conforming".
  it('BLOCKED on an unclosed brace rather than widening the body to end-of-file', () => {
    const res = runIn({
      'vite.config.ts': `export default { test: { environment: 'node',\nexclude: ['.claude/worktrees/**'];\n`,
    });
    expect(res.status, res.detail).toBe('blocked');
  });
});

/** Round-two review findings on the fixes above (tkt-5c0e00fae59d). */
describe('vitest-collection — resolver fail-opens found reviewing the fixes', () => {
  // An env assignment occupies the command position without being the command, so the ambiguity
  // guard never saw the root-level `vitest run` that collects the whole repo, worktree included.
  it('sees a `vitest` command behind a leading env assignment', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'NODE_ENV=test vitest run && npm --prefix server run test' } }),
      'server/vitest.config.ts': `export default { test: { exclude: ['dist/**'] } };\n`,
    });
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toContain('more than one vitest root');
  });

  it('sees a `vitest` command behind cross-env', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'cross-env NODE_ENV=test vitest run && npm --prefix server run test' } }),
      'server/vitest.config.ts': `export default { test: { exclude: ['dist/**'] } };\n`,
    });
    expect(res.status, res.detail).toBe('blocked');
  });

  // Truncating a quoted argument at the first space left a mangled token that matched nothing, and
  // the resolver then certified the ROOT config — a file `npm test` never reads.
  it('reads a quoted --prefix argument containing a space', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: "npm --prefix 'dir name' run test" } }),
      'vitest.config.ts': withExclude(['.claude/worktrees/**']),
      'dir name/vitest.config.ts': `export default { test: { exclude: ['dist/**'] } };\n`,
    });
    // The filename IS the assertion: before the fix the mangled token matched nothing and the
    // resolver reported the ROOT config, whose exclude is not the one `npm test` would apply.
    expect(res.detail).toContain('dir name');
  });

  it('reads a double-quoted --prefix argument containing a space', () => {
    const res = runIn({
      'package.json': JSON.stringify({ scripts: { test: 'npm --prefix "dir name" run test' } }),
      'vitest.config.ts': withExclude(['.claude/worktrees/**']),
      'dir name/vitest.config.ts': `export default { test: { exclude: ['dist/**'] } };\n`,
    });
    expect(res.detail).toContain('dir name');
  });
});
