import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  decide,
  namesExplicitTarget,
  readRepoState,
  resolveBase,
} from './guard-review-target.mjs';

// A scripted git: keys are the joined argv, values are stdout (status 0) or an explicit
// {status, stdout}. An unscripted call returns non-zero, so a test that forgets to script a
// step fails loudly instead of silently taking a fallback path.
const runner = (script) => (args) => {
  const hit = script[args.join(' ')];
  if (hit === undefined) return { status: 1, stdout: '' };
  return typeof hit === 'string' ? { status: 0, stdout: hit } : hit;
};

// A clean repo, level with origin/main — the exact state that produced the incident.
const LEVEL_AND_CLEAN = {
  'rev-parse --is-inside-work-tree': 'true\n',
  'status --porcelain': '',
  'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/main\n',
  'rev-list --count origin/main..HEAD': '0\n',
};

const repoOf = (script) => () => readRepoState(runner(script));
const review = (args) => ({ command_name: 'code-review', command_args: args });
const blocked = (payload, getRepo) => decide(payload, getRepo).blocked;

describe('namesExplicitTarget — a target is anything that is not an effort level or a flag', () => {
  it('treats a bare PR number, branch and path as targets', () => {
    expect(namesExplicitTarget('253')).toBe(true);
    expect(namesExplicitTarget('fix/tkt-abc-slug')).toBe(true);
    expect(namesExplicitTarget('projects/kanban')).toBe(true);
  });

  // The subtle half: these look like arguments but do not name WHAT to review, so the
  // silent-inference bug is still live and the guard must still run.
  it('does NOT count an effort level as a target', () => {
    for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ULTRA']) {
      expect(namesExplicitTarget(lvl)).toBe(false);
    }
  });

  it('does NOT count flags as targets', () => {
    expect(namesExplicitTarget('--fix')).toBe(false);
    expect(namesExplicitTarget('--comment --post')).toBe(false);
    expect(namesExplicitTarget('high --fix')).toBe(false);
  });

  it('finds the target when it is mixed with modifiers', () => {
    expect(namesExplicitTarget('ultra 253')).toBe(true);
    expect(namesExplicitTarget('--comment fix/my-branch')).toBe(true);
  });

  it('handles absent, empty and whitespace-only args', () => {
    expect(namesExplicitTarget(undefined)).toBe(false);
    expect(namesExplicitTarget('')).toBe(false);
    expect(namesExplicitTarget('   \t ')).toBe(false);
    expect(namesExplicitTarget(42)).toBe(false);
  });
});

describe('resolveBase — never silently defaults to main', () => {
  it('prefers origin/HEAD', () => {
    expect(resolveBase(runner(LEVEL_AND_CLEAN))).toBe('origin/main');
  });

  it('falls back through origin/main, origin/master, main, master', () => {
    expect(resolveBase(runner({ 'rev-parse --verify --quiet master': 'sha\n' }))).toBe('master');
  });

  it('returns null when no candidate resolves (caller must treat as indeterminate)', () => {
    expect(resolveBase(runner({}))).toBe(null);
  });
});

describe('readRepoState', () => {
  it('reports clean-and-level, which is the blocking condition', () => {
    expect(readRepoState(runner(LEVEL_AND_CLEAN))).toEqual({
      determinate: true, dirty: false, base: 'origin/main', ahead: 0,
    });
  });

  it('reports dirty when anything is modified or untracked', () => {
    const s = readRepoState(runner({ ...LEVEL_AND_CLEAN, 'status --porcelain': ' M src/a.ts\n' }));
    expect(s).toEqual({ determinate: true, dirty: true });
  });

  it('reports commits ahead of the base', () => {
    const s = readRepoState(runner({ ...LEVEL_AND_CLEAN, 'rev-list --count origin/main..HEAD': '3\n' }));
    expect(s.ahead).toBe(3);
  });

  it('is indeterminate outside a git working tree', () => {
    const s = readRepoState(runner({ 'rev-parse --is-inside-work-tree': 'false\n' }));
    expect(s.determinate).toBe(false);
  });

  it('is indeterminate when git is absent entirely (every call fails)', () => {
    expect(readRepoState(runner({})).determinate).toBe(false);
  });

  it('is indeterminate when no default branch can be resolved', () => {
    const s = readRepoState(runner({
      'rev-parse --is-inside-work-tree': 'true\n',
      'status --porcelain': '',
    }));
    expect(s.determinate).toBe(false);
    expect(s.why).toMatch(/default branch/);
  });

  // Number('') === 0, so a blank count would otherwise render "could not read" as "0 commits
  // ahead" — the permissive-looking answer for a broken probe.
  it('is indeterminate on an unreadable commit count, NOT treated as zero', () => {
    const s = readRepoState(runner({ ...LEVEL_AND_CLEAN, 'rev-list --count origin/main..HEAD': '\n' }));
    expect(s.determinate).toBe(false);
    expect(s.why).toMatch(/unreadable commit count/);
  });
});

describe('decide — blocks exactly the silent-inference case', () => {
  it('BLOCKS a bare review in a clean, level repo', () => {
    expect(blocked(review(''), repoOf(LEVEL_AND_CLEAN))).toBe(true);
  });

  it('blocks security-review and ultrareview the same way', () => {
    for (const command_name of ['security-review', 'ultrareview', '/code-review']) {
      expect(blocked({ command_name, command_args: '' }, repoOf(LEVEL_AND_CLEAN))).toBe(true);
    }
  });

  it('BLOCKS when only an effort level or a flag was passed', () => {
    expect(blocked(review('high'), repoOf(LEVEL_AND_CLEAN))).toBe(true);
    expect(blocked(review('--fix'), repoOf(LEVEL_AND_CLEAN))).toBe(true);
  });

  it('names the condition and both escapes in the reason', () => {
    const { reason } = decide(review(''), repoOf(LEVEL_AND_CLEAN));
    expect(reason).toMatch(/clean and has no commits/);
    expect(reason).toMatch(/explicit target/);
    expect(reason).toMatch(/start the session in the repository/i);
  });

  // Does not wedge legitimate work — the three ways a review is legitimate.
  it('ALLOWS when the tree is dirty', () => {
    const dirty = { ...LEVEL_AND_CLEAN, 'status --porcelain': ' M src/a.ts\n' };
    expect(blocked(review(''), repoOf(dirty))).toBe(false);
  });

  it('ALLOWS when the branch is ahead of the base', () => {
    const ahead = { ...LEVEL_AND_CLEAN, 'rev-list --count origin/main..HEAD': '2\n' };
    expect(blocked(review(''), repoOf(ahead))).toBe(false);
  });

  it('ALLOWS when an explicit target was named, whatever the repo state', () => {
    expect(blocked(review('253'), repoOf(LEVEL_AND_CLEAN))).toBe(false);
  });

  // The escape must not depend on git working — that is what keeps a broken environment from
  // blocking a review the user has already disambiguated.
  it('ALLOWS an explicit target WITHOUT calling git at all', () => {
    let called = 0;
    const spy = () => { called += 1; return { determinate: false, why: 'should never be consulted' }; };
    expect(blocked(review('projects/kanban'), spy)).toBe(false);
    expect(called).toBe(0);
  });

  it('ignores commands it does not guard', () => {
    expect(blocked({ command_name: 'commit', command_args: '' }, repoOf(LEVEL_AND_CLEAN))).toBe(false);
  });

  // Fail CLOSED — "cannot check" must never be the permissive answer.
  it('BLOCKS when the repo state is indeterminate', () => {
    expect(blocked(review(''), () => ({ determinate: false, why: 'not inside a git working tree' }))).toBe(true);
    expect(blocked(review(''), () => undefined)).toBe(true);
  });

  it('BLOCKS on a missing or non-string command name', () => {
    expect(blocked({}, repoOf(LEVEL_AND_CLEAN))).toBe(true);
    expect(blocked({ command_name: 42 }, repoOf(LEVEL_AND_CLEAN))).toBe(true);
  });
});

describe('hook entrypoint (stdin → exit code)', () => {
  const hook = fileURLToPath(new URL('./guard-review-target.mjs', import.meta.url));
  // cwd is this repo: a clean checkout on a branch WITH commits ahead of main, or a dirty one.
  const runHook = (payload, cwd) =>
    spawnSync('node', [hook], { input: payload, encoding: 'utf8', cwd });

  it('exits 2 and surfaces the reason when the payload is unparseable (fails closed)', () => {
    const r = runHook('not json');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('[guard-review-target]');
  });

  it('exits 2 in a directory that is not a git repo', () => {
    const r = runHook(JSON.stringify({ command_name: 'code-review', command_args: '' }), '/');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not be determined/);
  });

  it('exits 0 for an explicit target even outside a git repo', () => {
    const r = runHook(JSON.stringify({ command_name: 'code-review', command_args: '253' }), '/');
    expect(r.status).toBe(0);
  });

  it('exits 0 for a command it does not guard', () => {
    const r = runHook(JSON.stringify({ command_name: 'compact', command_args: '' }), '/');
    expect(r.status).toBe(0);
  });
});
