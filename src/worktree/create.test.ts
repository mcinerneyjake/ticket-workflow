import { describe, expect, it } from 'vitest';
import type { Exec, ExecResult } from '../audit/types.js';
import {
  baseCandidates,
  branchName,
  createWorktree,
  PREFIX_BY_TYPE,
  resolveBase,
  slugify,
  worktreePath,
} from './create.js';

/**
 * A git double driven by the ARGUMENTS, recording every call. Enumerated per dimension rather than
 * sampled: absent binary · not a repo · branch present/absent · worktree path present/absent · base
 * resolvable/unresolvable/explicit-but-missing · add succeeding/failing. A suite that varies nothing
 * cannot report absence.
 */
function fakeGit(
  handler: (args: readonly string[]) => ExecResult | undefined,
  calls: string[][] = [],
): { exec: Exec; calls: string[][] } {
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return handler(args) ?? { kind: 'ran', ok: false, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

const ok = (stdout = ''): ExecResult => ({ kind: 'ran', ok: true, stdout, stderr: '' });
const fail = (): ExecResult => ({ kind: 'ran', ok: false, stdout: '', stderr: '' });

/** The happy path: repo exists, branch free, path free, origin/HEAD resolves, add succeeds. */
function healthy(overrides: (args: readonly string[]) => ExecResult | undefined = () => undefined) {
  return fakeGit((args) => {
    const o = overrides(args);
    if (o) return o;
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok('/repo');
    if (args[0] === 'symbolic-ref') return ok('origin/main');
    if (args[0] === 'rev-parse' && args.includes('refs/heads/feat/tkt-1-x')) return fail();
    if (args[0] === 'rev-parse' && args.includes('origin/main^{commit}')) return ok('abc');
    if (args[0] === 'worktree' && args[1] === 'list') return ok('');
    if (args[0] === 'worktree' && args[1] === 'add') return ok('');
    return fail();
  });
}

describe('slug and branch naming', () => {
  it('lowercases, drops symbols and caps at five words', () => {
    expect(slugify('Verify & update PROVISIONAL CSS selectors for the extractor')).toBe(
      'verify-update-provisional-css-selectors',
    );
  });

  it('yields an empty slug for a title with nothing usable, and the branch omits the trailing dash', () => {
    expect(slugify('!!! ---')).toBe('');
    expect(branchName('task', 'tkt-1', '!!! ---')).toBe('task/tkt-1');
  });

  it('maps every ticket type to a prefix', () => {
    expect(PREFIX_BY_TYPE).toEqual({ bug: 'fix', feature: 'feat', task: 'task', chore: 'chore' });
  });

  it('nests the worktree inside the repo, so node resolves upward to the main checkout', () => {
    expect(worktreePath('tkt-1')).toBe('.claude/worktrees/tkt-1');
  });
});

describe('resolveBase', () => {
  it('prefers the repo’s own origin/HEAD', () => {
    const { exec } = fakeGit((args) => {
      if (args[0] === 'symbolic-ref') return ok('origin/trunk');
      if (args.includes('origin/trunk^{commit}')) return ok('abc');
      return fail();
    });
    expect(resolveBase(exec, '/repo')).toBe('origin/trunk');
  });

  it('falls back to a LOCAL branch when there is no remote at all', () => {
    // Measured: 3 of 9 repositories on this machine have no remote. A remote-only resolver would
    // refuse in exactly the repos where a local worktree is the only isolation available.
    const { exec } = fakeGit((args) => {
      if (args[0] === 'symbolic-ref') return fail();
      if (args.includes('master^{commit}')) return ok('abc');
      return fail();
    });
    expect(resolveBase(exec, '/repo')).toBe('master');
  });

  it('returns null rather than guessing when nothing resolves', () => {
    const { exec } = fakeGit(() => fail());
    expect(resolveBase(exec, '/repo')).toBeNull();
  });
});

describe('createWorktree refuses rather than guessing', () => {
  it('when git is not on PATH', () => {
    const { exec } = fakeGit(() => ({ kind: 'absent' }));
    const r = createWorktree({ repoDir: '/repo', branch: 'feat/tkt-1-x' }, exec);
    expect(r).toEqual({ kind: 'refused', reason: 'git is not on PATH, so no worktree can be created' });
  });

  it('when the directory is not a git repository', () => {
    const { exec } = fakeGit(() => fail());
    const r = createWorktree({ repoDir: '/tmp', branch: 'feat/tkt-1-x' }, exec);
    expect(r.kind).toBe('refused');
    expect(r.kind === 'refused' && r.reason).toMatch(/not inside a git repository/);
  });

  it('when the branch already exists — the shape that would silently reuse someone else’s branch', () => {
    const { exec } = healthy((args) =>
      args[0] === 'rev-parse' && args.includes('refs/heads/feat/tkt-1-x') ? ok('abc') : undefined,
    );
    const r = createWorktree({ repoDir: '/repo', branch: 'feat/tkt-1-x' }, exec);
    expect(r.kind === 'refused' && r.reason).toMatch(/branch feat\/tkt-1-x already exists/);
  });

  it('when a worktree already occupies the path', () => {
    const { exec } = healthy((args) =>
      args[0] === 'worktree' && args[1] === 'list'
        ? ok('worktree /repo/.claude/worktrees/tkt-1-x\nHEAD abc\n')
        : undefined,
    );
    const r = createWorktree({ repoDir: '/repo', branch: 'feat/tkt-1-x' }, exec);
    expect(r.kind === 'refused' && r.reason).toMatch(/already exists at \.claude\/worktrees\/tkt-1-x/);
  });

  it('when no base can be resolved — it names the flag instead of defaulting to main', () => {
    const { exec } = fakeGit((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok('/repo');
      return fail();
    });
    const r = createWorktree({ repoDir: '/repo', branch: 'feat/tkt-1-x' }, exec);
    expect(r.kind === 'refused' && r.reason).toMatch(/could not resolve a base branch.*--base/);
  });

  it('when an EXPLICIT base does not exist — a typo must not reach git as a pathspec', () => {
    const { exec } = healthy((args) => (args.includes('origin/tpyo^{commit}') ? fail() : undefined));
    const r = createWorktree({ repoDir: '/repo', branch: 'feat/tkt-1-x', base: 'origin/tpyo' }, exec);
    expect(r.kind === 'refused' && r.reason).toMatch(/base ref origin\/tpyo does not exist/);
  });

  it('when git worktree add itself fails', () => {
    const { exec } = healthy((args) =>
      args[0] === 'worktree' && args[1] === 'add' ? fail() : undefined,
    );
    const r = createWorktree({ repoDir: '/repo', branch: 'feat/tkt-1-x' }, exec);
    expect(r.kind === 'refused' && r.reason).toMatch(/git worktree add failed/);
  });
});

describe('createWorktree happy path', () => {
  it('creates the branch at the resolved base, inside .claude/worktrees', () => {
    const { exec, calls } = healthy();
    const r = createWorktree({ repoDir: '/repo', branch: 'feat/tkt-1-x' }, exec);
    expect(r).toEqual({
      kind: 'created',
      path: '.claude/worktrees/tkt-1-x',
      branch: 'feat/tkt-1-x',
      base: 'origin/main',
    });
    // The command actually issued, asserted rather than assumed — the outcome object would look
    // identical if the add had been skipped entirely.
    expect(calls).toContainEqual([
      'git', 'worktree', 'add', '-b', 'feat/tkt-1-x', '.claude/worktrees/tkt-1-x', 'origin/main',
    ]);
  });

  it('honours an explicit --name for the directory while keeping the branch', () => {
    const { exec } = healthy();
    const r = createWorktree({ repoDir: '/repo', branch: 'feat/tkt-1-x', name: 'wt' }, exec);
    expect(r.kind === 'created' && r.path).toBe('.claude/worktrees/wt');
  });
});

interface DefaultBranchModule {
  resolveBaseRef(cwd: string, git: (args: readonly string[], cwd?: string) => { out?: string; err?: string }): string | null;
}

/** Runtime shape check, so the untyped import above is narrowed by evidence rather than asserted. */
function hasResolveBaseRef(m: unknown): m is DefaultBranchModule {
  return typeof m === 'object' && m !== null && typeof Reflect.get(m, 'resolveBaseRef') === 'function';
}

describe('the base-ref ladder does not drift from the hooks implementation', () => {
  // The ladder exists twice — here in TypeScript and in hooks/lib/default-branch.mjs, which `src`
  // cannot import because it is plain .mjs outside the TS program. So the copy is held by THIS
  // test rather than by a comment asking someone to keep them in sync: it drives the hooks
  // function with a recording double and asserts it probes exactly the refs this module lists.
  it('probes the same refs, in the same order', async () => {
    // Directive, not prose: hooks/ is plain .mjs outside the TS program, so there is no declaration
    // to import. A hand-written .d.mts would be a SECOND thing that can drift from the .mjs — the
    // exact problem this test exists to catch — so the shape is proven at runtime instead.
    // @ts-expect-error -- untyped .mjs; validated by hasResolveBaseRef below
    const mod: unknown = await import('../../hooks/lib/default-branch.mjs');
    if (!hasResolveBaseRef(mod)) throw new Error('default-branch.mjs does not export resolveBaseRef');
    const probed: string[] = [];
    const recordingGit = (args: readonly string[]): { out?: string; err?: string } => {
      if (args[0] === 'symbolic-ref') return { out: 'origin/trunk' };
      if (args[0] === 'rev-parse') {
        // The ref is the LAST argument (`rev-parse --verify --quiet <ref>^{commit}`), not a fixed
        // index — reading index 2 collected "--quiet" five times, which this test caught.
        probed.push(String(args[args.length - 1]).replace(/\^\{commit\}$/, ''));
        return { out: '' }; // never resolves, so it walks the whole ladder
      }
      return { out: '' };
    };
    mod.resolveBaseRef('/repo', recordingGit);
    expect(probed).toEqual([...baseCandidates('origin/trunk')]);
  });
});
