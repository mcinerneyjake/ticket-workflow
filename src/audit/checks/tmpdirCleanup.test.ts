import { describe, expect, it } from 'vitest';
import { tmpdirCleanup, argumentsOf, bindingBefore, leaksIn, maskLiterals, removedNames } from './tmpdirCleanup.js';
import { auditExitCode, type AuditReport } from '../run.js';
import type { AuditContext, ExecResult, ReadResult } from '../types.js';

/** Stubbed index + reads: no subprocess and no real directory, so the rejection cases below are
 *  reachable at all — `git is not on PATH` cannot be staged against a machine that has git. */
function run(files: Record<string, string>, over?: { exec?: ExecResult; read?: ReadResult }) {
  const ctx: AuditContext = {
    repoDir: '/repo',
    read: (rel) => over?.read ?? (rel in files ? { kind: 'ok', contents: files[rel] } : { kind: 'missing' }),
    exec: () => over?.exec ?? { kind: 'ran', ok: true, status: 0, stdout: Object.keys(files).join('\0'), stderr: '' },
  };
  return tmpdirCleanup.run(ctx);
}

const CLEAN = `import { mkdtempSync, rmSync } from 'node:fs';
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dir = mkdtempSync(path.join(tmpdir(), 'x-'));
dirs.push(dir);
`;

describe('tmpdir-cleanup — a bound root that reaches a removal is clean', () => {
  it('PASSES the const-declared, rmSync-ed shape', () => {
    const res = run({ 'a.test.ts': CLEAN });
    expect(res.status, res.detail).toBe('pass');
  });

  it('PASSES a root bound through realpathSync, which returns the same directory', () => {
    const res = run({
      'a.test.mjs': `const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'x-')));\nrmSync(dir, { recursive: true });\n`,
    });
    expect(res.status, res.detail).toBe('pass');
  });

  it('PASSES an awaited member call whose binding is removed', () => {
    const res = run({
      'a.test.ts': `const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'x-'));\nawait fs.rm(dir, { recursive: true });\n`,
    });
    expect(res.status, res.detail).toBe('pass');
  });

  it('PASSES a reassignment to a let, removed by name', () => {
    const res = run({
      'a.test.ts': `let root;\nbeforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'x-')); });\nafterEach(() => { rmSync(root, { recursive: true }); });\n`,
    });
    expect(res.status, res.detail).toBe('pass');
  });

  it('PASSES a mkdtemp rooted somewhere other than os.tmpdir()', () => {
    const res = run({ 'a.test.ts': `const d = mkdtempSync(path.join(alreadyTempRoot, 'ev-'));\n` });
    expect(res.status, res.detail).toBe('pass');
  });

  /** The message must name the patterns it matched on: a repo laying suites out some other way gets
   *  a clean verdict nobody measured, and saying "no test files" would hide that. */
  it('PASSES a repo whose index matches no test-file pattern, naming the patterns', () => {
    const res = run({ 'src/index.ts': CLEAN });
    expect(res.status, res.detail).toBe('pass');
    expect(res.detail).toContain('NOT covered');
    expect(res.detail).toContain('test-support/');
  });
});

describe('tmpdir-cleanup — the two leak shapes', () => {
  it('FAILS a bound root that no removal call ever names', () => {
    const res = run({ 'a.test.ts': `const root = mkdtempSync(path.join(tmpdir(), 'x-'));\n` });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('a.test.ts:1 (root)');
  });

  it('FAILS a root removed only by a DIFFERENT name — the post-merge shape', () => {
    const res = run({
      'a.test.ts': `const root = mkdtempSync(path.join(tmpdir(), 'x-'));\nrmSync(path.join(dirty, 'linkme.txt'));\n`,
    });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('(root)');
  });

  it('FAILS an unbound creation used as an object-property value', () => {
    const res = run({
      'a.test.mjs': `spawn({ env: { EVENTS_DIR_OVERRIDE: mkdtempSync(path.join(tmpdir(), 'ev-')) } });\n`,
    });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('(unbound)');
  });

  it('FAILS a root wrapped in path.join, whose binding is a CHILD — removing it leaves the root', () => {
    const res = run({
      'a.test.mjs': `orphan = path.join(mkdtempSync(path.join(tmpdir(), 'x-')), 'precheck.mjs');\nrmSync(orphan);\n`,
    });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('(unbound)');
  });

  it('counts every leaking site and names the file count', () => {
    const res = run({
      'a.test.ts': `const a = mkdtempSync(path.join(tmpdir(), 'a-'));\nconst b = mkdtempSync(path.join(tmpdir(), 'b-'));\n`,
      'b.spec.tsx': `const c = mkdtempSync(path.join(tmpdir(), 'c-'));\n`,
    });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('3 os.tmpdir() directories in 2 test files');
  });
});

describe('tmpdir-cleanup — file selection', () => {
  it.each(['a.test.ts', 'a.test.mjs', 'a.test.cjs', 'a.spec.tsx', 'deep/dir/a.test.js'])('scans %s', (name) => {
    const res = run({ [name]: `const r = mkdtempSync(path.join(tmpdir(), 'x-'));\n` });
    expect(res.status, res.detail).toBe('fail');
  });

  it.each(['src/attest.ts', 'a.testing.ts', 'test.ts', 'a.test.txt'])('ignores %s', (name) => {
    const res = run({ [name]: `const r = mkdtempSync(path.join(tmpdir(), 'x-'));\n` });
    expect(res.status, res.detail).toBe('pass');
  });
});

describe('tmpdir-cleanup — "could not determine" is never the clean answer', () => {
  it('BLOCKS when git is not on PATH', () => {
    const res = run({ 'a.test.ts': CLEAN }, { exec: { kind: 'absent' } });
    expect(res.status).toBe('blocked');
    expect(res.detail).toContain('not on PATH');
  });

  it('BLOCKS when git ls-files errors', () => {
    const res = run({ 'a.test.ts': CLEAN }, { exec: { kind: 'error', message: 'spawn EAGAIN' } });
    expect(res.status).toBe('blocked');
    expect(res.detail).toContain('spawn EAGAIN');
  });

  it('BLOCKS when git ls-files exits non-zero', () => {
    const res = run(
      { 'a.test.ts': CLEAN },
      { exec: { kind: 'ran', ok: false, status: 128, stdout: '', stderr: 'not a git repository\n' } },
    );
    expect(res.status).toBe('blocked');
    expect(res.detail).toContain('not a git repository');
  });

  it('BLOCKS when a tracked test file cannot be read, rather than scanning the rest', () => {
    const res = run({ 'a.test.ts': CLEAN }, { read: { kind: 'error', message: 'EACCES' } });
    expect(res.status).toBe('blocked');
    expect(res.detail).toContain('EACCES');
  });

  it('BLOCKS when a tracked test file is absent — the scan would be partial', () => {
    const res = run({ 'a.test.ts': CLEAN }, { read: { kind: 'missing' } });
    expect(res.status).toBe('blocked');
    expect(res.detail).toContain('partial');
  });
});

describe('tmpdir-cleanup — advisory means a FAIL cannot move the exit code', () => {
  it('leaves auditExitCode at 0', () => {
    const res = run({ 'a.test.ts': `const r = mkdtempSync(path.join(tmpdir(), 'x-'));\n` });
    expect(res.status).toBe('fail');
    expect(res.advisory).toBe(true);
    const report: AuditReport = { repoDir: '/repo', tier: 'node', tierDeclared: true, results: [res] };
    expect(auditExitCode(report)).toBe(0);
  });
});

/** argumentsOf is paren-balancing only; masking is what makes a paren inside a string harmless, so
 *  these drive the pair together rather than argumentsOf on raw source. */
describe('argumentsOf over masked source — a paren inside a string cannot end the scan early', () => {
  const argsOfFirstCall = (src: string) => {
    const masked = maskLiterals(src);
    return argumentsOf(masked, masked.indexOf('('));
  };

  it('reads past a quoted close-paren', () => {
    expect(argsOfFirstCall(`f(join(tmpdir(), 'a)b'))`)).toBe(`join(tmpdir(), '   ')`);
  });

  it('reads past an escaped quote', () => {
    expect(argsOfFirstCall(`f('a\\'(', tmpdir())`)).toContain('tmpdir()');
  });

  it('reads past a close-paren inside a comment', () => {
    expect(argsOfFirstCall(`f(a /* ) */, tmpdir())`)).toContain('tmpdir()');
  });

  it('returns the remainder when the call is never closed, over-matching rather than under', () => {
    expect(argumentsOf('f(tmpdir()', 1)).toBe('tmpdir()');
  });
});

describe('bindingBefore — what does and does not name a root', () => {
  it.each([
    ['const dir = ', 'dir'],
    ['  let root = ', 'root'],
    ['root = ', 'root'],
    ['const dir = await ', 'dir'],
    ['const dir = realpathSync(', 'dir'],
    ['const dir = fs.realpath(', 'dir'],
  ])('%j binds %s', (before, expected) => {
    expect(bindingBefore(before)).toBe(expected);
  });

  it.each([
    'env: { KEY: ',
    'orphan = path.join(',
    'const f = () => ',
    'if (a === ',
    'if (a !== ',
    'return ',
  ])('%j binds nothing', (before) => {
    expect(bindingBefore(before)).toBeUndefined();
  });
});

/**
 * The binding reaches its removal only through an array, so the removal call names the loop
 * variable and never the binding. Both genuinely clean suites in this repo spell that loop variable
 * `dir` — the same identifier as their binding — so a check without the collector hop passes them
 * by coincidence and fails the moment someone renames a loop variable.
 */
describe('tmpdir-cleanup — the collector-array indirection', () => {
  it('PASSES a one-line drain whose loop variable differs from the binding', () => {
    const res = run({
      'a.test.ts': `const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true }); });
const dir = mkdtempSync(path.join(tmpdir(), 'x-'));
dirs.push(dir);
`,
    });
    expect(res.status, res.detail).toBe('pass');
  });

  it('PASSES the same drain written with a block body', () => {
    const res = run({
      'a.test.ts': `const tempDirs = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});
const root = mkdtempSync(path.join(tmpdir(), 'x-'));
tempDirs.push(root);
`,
    });
    expect(res.status, res.detail).toBe('pass');
  });

  /**
   * The fixture carries a REAL removal call deliberately. Without one this test passed against a
   * check that excused any collector merely named near a removal — it sampled one point in the very
   * dimension it claims to cover, and every real suite has removal calls.
   */
  it('still FAILS a root pushed into a collector nothing drains, even beside a real removal', () => {
    const res = run({
      'a.test.ts': `const kept = [];
const dir = mkdtempSync(path.join(tmpdir(), 'x-'));
kept.push(dir);
rmSync(someUnrelatedFile);
`,
    });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('(dir)');
  });

  it('requires a drain site, not merely the collector name near a removal', () => {
    const named = `const kept = [];
const dir = mkdtempSync(path.join(tmpdir(), 'x-'));
kept.push(dir);
rmSync(other, { recursive: true });
`;
    expect(leaksIn('a.test.ts', named)).toHaveLength(1);
    expect(leaksIn('a.test.ts', named.replace('rmSync(other', 'for (const d of kept) rmSync(d'))).toEqual([]);
  });
});

describe('tmpdir-cleanup — comments and strings are not code', () => {
  const CREATE = `const root = mkdtempSync(path.join(tmpdir(), 'x-'));`;

  it('does not let a comment mentioning rmSync excuse a real leak', () => {
    const res = run({ 'a.test.ts': `/** call rmSync(root) yourself */\n${CREATE}` });
    expect(res.status, res.detail).toBe('fail');
  });

  it('does not let an assertion STRING containing rmSync excuse a real leak', () => {
    const res = run({ 'a.test.ts': `expect(src).toContain('rmSync(root)');\n${CREATE}` });
    expect(res.status, res.detail).toBe('fail');
  });

  it("does not desync on an apostrophe inside a comment in a removal's arguments", () => {
    const res = run({ 'a.test.ts': `rmSync(other, {\n  // we don't recurse\n  force: true,\n});\n${CREATE}` });
    expect(res.status, res.detail).toBe('fail');
  });

  it('does not let option keys excuse a binding that shares their name', () => {
    const res = run({
      'a.test.ts': `rmSync(other, { recursive: true, force: true });\nconst force = mkdtempSync(path.join(tmpdir(), 'x-'));`,
    });
    expect(res.status, res.detail).toBe('fail');
  });

  it('still sees a tmpdir call inside a template interpolation', () => {
    expect(leaksIn('a.test.ts', 'const r = mkdtempSync(`${tmpdir()}/x-`);')).toHaveLength(1);
  });

  it('masks a regex literal rather than reading its quote as a string start', () => {
    const masked = maskLiterals(`const re = /don't/;\nconst root = mkdtempSync(path.join(tmpdir(), 'x-'));`);
    expect(masked).toContain('tmpdir(');
    expect(masked).not.toContain("don't");
  });
});

describe('tmpdir-cleanup — TypeScript annotations (every consumer is a TS repo)', () => {
  it('PASSES annotated, properly removed code instead of reporting a binding named after the type', () => {
    const res = run({
      'a.test.ts': `const dir: string = mkdtempSync(path.join(tmpdir(), 'x-'));\nrmSync(dir, { recursive: true, force: true });`,
    });
    expect(res.status, res.detail).toBe('pass');
  });

  it.each([
    ['const dir: string = ', 'dir'],
    ['let root: string | undefined = ', 'root'],
    ['  let scratch: Array<string> = ', 'scratch'],
  ])('%j binds %s', (before, expected) => {
    expect(bindingBefore(before)).toBe(expected);
  });

  it('FAILS an annotated binding that is never removed', () => {
    const res = run({ 'a.test.ts': `const dir: string = mkdtempSync(path.join(tmpdir(), 'x-'));` });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('(dir)');
  });
});

describe('tmpdir-cleanup — a tmpdir root held in a variable', () => {
  it.each([
    ['direct alias', `const base = os.tmpdir();\nconst dir = mkdtempSync(path.join(base, 'x-'));`],
    ['prefix alias', `const TMP_ROOT = path.join(os.tmpdir(), 'tw-');\nconst dir = mkdtempSync(TMP_ROOT);`],
    ['alias of an alias', `const a = os.tmpdir();\nconst b = path.join(a, 'p');\nconst dir = mkdtempSync(b);`],
  ])('detects a leak through a %s', (_name, src) => {
    expect(leaksIn('a.test.ts', src)).toHaveLength(1);
  });

  it('still ignores a root that is genuinely not under tmpdir', () => {
    expect(leaksIn('a.test.ts', `const base = repoRoot;\nconst d = mkdtempSync(path.join(base, 'ev-'));`)).toEqual([]);
  });
});

describe('removedNames — the documented file-scoped limit', () => {
  it('collects identifiers from every removal spelling', () => {
    const names = removedNames('rmSync(a); rmdirSync(b); await fs.rm(c); rmdir(d);');
    expect([...names]).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));
  });

  it('does not match an identifier that merely starts with rm', () => {
    expect(removedNames('rmTree(a); formatter(b);').has('a')).toBe(false);
  });

  it('UNDER-reports across scopes by design: a name removed anywhere excuses it everywhere', () => {
    const src = `function one() { const dir = mkdtempSync(path.join(tmpdir(), 'x-')); }
function two() { const dir = makeSomethingElse(); rmSync(dir); }`;
    expect(leaksIn('a.test.ts', src)).toEqual([]);
  });
});
