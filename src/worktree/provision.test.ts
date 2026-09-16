import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultExec, type Exec, type ExecResult } from '../audit/types.js';
import { cmdWorktree } from '../cli/index.js';
import { getTicket } from '../server/tickets.js';
import { createWorktree } from './create.js';
import { provisionFailed, provisionWorktree, type ProvisionEntry, type ProvisionOutcome } from './provision.js';

/**
 * A REAL repository and a REAL linked worktree per case: the semantics under test are git's own
 * (ignore matching, trailing-slash patterns against a symlink), so a git double would assert what
 * the double was told rather than what git does.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.email=x@example.com', '-c', 'user.name=x', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function fixture(files: Record<string, string>, gitignore = '.env\nlocal/\nnode_modules\n.claude/worktrees\n') {
  const root = mkdtempSync(path.join(tmpdir(), 'tw-provision-'));
  dirs.push(root);
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, '.gitignore'), gitignore);
  writeFileSync(path.join(repo, 'tracked.txt'), 'tracked');
  git(repo, 'add', '.gitignore', 'tracked.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), contents);
  }
  const worktree = path.join(repo, '.claude', 'worktrees', 'wt');
  git(repo, 'worktree', 'add', '-q', '--detach', worktree, 'main');
  return { root, repo, worktree };
}

function entries(outcome: ProvisionOutcome): readonly ProvisionEntry[] {
  if (outcome.kind !== 'provisioned') throw new Error(`expected provisioned, got refused: ${outcome.reason}`);
  return outcome.entries;
}

const kindOf = (outcome: ProvisionOutcome, rel: string) => entries(outcome).find((e) => e.path === rel)?.kind;

/** defaultExec with one git subcommand replaced — the only way to reach git's failure exits for real. */
function execOverriding(sub: string, result: ExecResult): Exec {
  return (cmd, args, opts) => (cmd === 'git' && args[0] === sub ? result : defaultExec(cmd, args, opts));
}

describe('.worktreeinclude copies', () => {
  it('copies an entry git ignores, and NOT one that merely matches — the native CLI’s rule', () => {
    const { repo, worktree } = fixture({
      '.env': 'SECRET=1',
      'notes.md': 'untracked, not ignored',
      '.worktreeinclude': '.env\nnotes.md\n',
    });
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });

    expect(kindOf(out, '.env')).toBe('copied');
    expect(readFileSync(path.join(worktree, '.env'), 'utf8')).toBe('SECRET=1');
    expect(kindOf(out, 'notes.md')).toBe('skipped');
    expect(existsSync(path.join(worktree, 'notes.md'))).toBe(false);
    expect(provisionFailed(out)).toBe(false);
  });

  it('never lists a tracked file, which the checkout already carries', () => {
    const { repo, worktree } = fixture({ '.worktreeinclude': 'tracked.txt\n' });
    expect(entries(provisionWorktree({ repoDir: repo, worktreeDir: worktree }))).toEqual([]);
  });

  it('creates missing parent directories for a nested entry', () => {
    const { repo, worktree } = fixture({ 'local/deep/cfg.json': '{}', '.worktreeinclude': 'local/\n' });
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(out, 'local/deep/cfg.json')).toBe('copied');
    expect(existsSync(path.join(worktree, 'local/deep/cfg.json'))).toBe(true);
  });

  it('refuses a symlinked source rather than copying what it points at', () => {
    const { root, repo, worktree } = fixture({ '.worktreeinclude': '.env\n' });
    writeFileSync(path.join(root, 'outside'), 'elsewhere');
    symlinkSync(path.join(root, 'outside'), path.join(repo, '.env'));
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(out, '.env')).toBe('failed');
    expect(existsSync(path.join(worktree, '.env'))).toBe(false);
    expect(provisionFailed(out)).toBe(true);
  });

  it('refuses to write through a destination directory that is a symlink out of the worktree', () => {
    const { root, repo, worktree } = fixture({ 'local/cfg.json': 'x', '.worktreeinclude': 'local/\n' });
    const outside = path.join(root, 'escape');
    mkdirSync(outside);
    symlinkSync(outside, path.join(worktree, 'local'));
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(out, 'local/cfg.json')).toBe('failed');
    expect(existsSync(path.join(outside, 'cfg.json'))).toBe(false);
  });

  it('never overwrites a destination, and a second run changes nothing and still succeeds', () => {
    const { repo, worktree } = fixture({ '.env': 'from-primary', '.worktreeinclude': '.env\n' });
    expect(kindOf(provisionWorktree({ repoDir: repo, worktreeDir: worktree }), '.env')).toBe('copied');
    writeFileSync(path.join(worktree, '.env'), 'edited-in-worktree');

    const again = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(again, '.env')).toBe('present');
    expect(readFileSync(path.join(worktree, '.env'), 'utf8')).toBe('edited-in-worktree');
    expect(provisionFailed(again)).toBe(false);
  });

  it('resolves the repository root when handed a subdirectory', () => {
    const { repo, worktree } = fixture({ '.env': 'x', 'local/a': 'y', '.worktreeinclude': '.env\n' });
    const out = provisionWorktree({ repoDir: path.join(repo, 'local'), worktreeDir: worktree });
    expect(kindOf(out, '.env')).toBe('copied');
  });

  it.each(['directory', 'symlink'] as const)('refuses a .worktreeinclude that is a %s, never reading it as undeclared', (shape) => {
    const { root, repo, worktree } = fixture({ '.env': 'x' });
    if (shape === 'directory') mkdirSync(path.join(repo, '.worktreeinclude'));
    else {
      writeFileSync(path.join(root, 'inc'), '.env\n');
      symlinkSync(path.join(root, 'inc'), path.join(repo, '.worktreeinclude'));
    }
    expect(provisionWorktree({ repoDir: repo, worktreeDir: worktree }).kind).toBe('refused');
  });
});

describe('worktree.symlinkDirectories links', () => {
  const settings = (dirsValue: unknown) => JSON.stringify({ worktree: { symlinkDirectories: dirsValue } });

  it('links a declared directory that git ignores as a symlink', () => {
    const { repo, worktree } = fixture({ 'node_modules/pkg/index.js': '', '.claude/settings.json': settings(['node_modules']) });
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(out, 'node_modules')).toBe('linked');
    expect(lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(realpathSync(path.join(worktree, 'node_modules'))).toBe(realpathSync(path.join(repo, 'node_modules')));
    expect(provisionFailed(out)).toBe(false);
  });

  it('removes and fails a link that a trailing-slash pattern leaves unignored', () => {
    const { repo, worktree } = fixture(
      { 'node_modules/pkg/index.js': '', '.claude/settings.json': settings(['node_modules']) },
      'node_modules/\n.claude/worktrees\n',
    );
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(out, 'node_modules')).toBe('failed');
    expect(existsSync(path.join(worktree, 'node_modules'))).toBe(false);
    expect(provisionFailed(out)).toBe(true);
  });

  it('reports an existing correct link as present, so a re-run is a success', () => {
    const { repo, worktree } = fixture({ 'node_modules/x': '', '.claude/settings.json': settings(['node_modules']) });
    // Linked by hand through the unresolved spelling, as a session's `ln -s` would.
    symlinkSync(path.join(repo, 'node_modules'), path.join(worktree, 'node_modules'));
    const again = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(again, 'node_modules')).toBe('present');
    expect(provisionFailed(again)).toBe(false);
  });

  it('fails when a real directory already occupies the path — the late-link trap', () => {
    const { repo, worktree } = fixture({ 'node_modules/x': '', '.claude/settings.json': settings(['node_modules']) });
    mkdirSync(path.join(worktree, 'node_modules'));
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(out, 'node_modules')).toBe('failed');
    expect(lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink()).toBe(false);
  });

  it('skips a declared directory the source checkout does not have', () => {
    const { repo, worktree } = fixture({ '.claude/settings.json': settings(['node_modules']) });
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(out, 'node_modules')).toBe('skipped');
    expect(provisionFailed(out)).toBe(false);
  });

  it.each(['/etc', '../outside', 'a/../../b', ''])('fails an entry that is not a path inside the repo: %j', (entry) => {
    const { repo, worktree } = fixture({ '.claude/settings.json': settings([entry]) });
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(out, entry)).toBe('failed');
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a non-object', '[]'],
    ['a non-object worktree key', JSON.stringify({ worktree: 'node_modules' })],
    ['a non-array value', settings('node_modules')],
    ['a non-string element', settings(['node_modules', 3])],
  ])('refuses settings with %s rather than reading it as nothing declared', (_label, contents) => {
    const { repo, worktree } = fixture({ '.claude/settings.json': contents });
    expect(provisionWorktree({ repoDir: repo, worktreeDir: worktree }).kind).toBe('refused');
  });
});

describe('nothing declared, and what cannot be determined', () => {
  it('succeeds with declared: false when neither file declares anything', () => {
    const { repo, worktree } = fixture({ '.claude/settings.json': JSON.stringify({ permissions: {} }) });
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(out).toEqual({ kind: 'provisioned', declared: false, entries: [] });
    expect(provisionFailed(out)).toBe(false);
  });

  it('refuses when git is absent', () => {
    const { repo, worktree } = fixture({});
    expect(provisionWorktree({ repoDir: repo, worktreeDir: worktree }, () => ({ kind: 'absent' })).kind).toBe('refused');
  });

  it('refuses when check-ignore exits fatally, instead of reading it as "nothing ignored"', () => {
    const { repo, worktree } = fixture({ '.env': 'x', '.worktreeinclude': '.env\n' });
    const exec = execOverriding('check-ignore', { kind: 'ran', ok: false, status: 128, stdout: '', stderr: 'fatal' });
    expect(provisionWorktree({ repoDir: repo, worktreeDir: worktree }, exec).kind).toBe('refused');
    expect(existsSync(path.join(worktree, '.env'))).toBe(false);
  });

  it('refuses when the exec reports failure with no exit status', () => {
    const { repo, worktree } = fixture({ '.env': 'x', '.worktreeinclude': '.env\n' });
    const exec = execOverriding('check-ignore', { kind: 'ran', ok: false, stdout: '', stderr: '' });
    expect(provisionWorktree({ repoDir: repo, worktreeDir: worktree }, exec).kind).toBe('refused');
  });

  it('fails and removes a link whose ignore status cannot be confirmed', () => {
    const { repo, worktree } = fixture({ 'node_modules/x': '', '.claude/settings.json': JSON.stringify({ worktree: { symlinkDirectories: ['node_modules'] } }) });
    const exec = execOverriding('check-ignore', { kind: 'error', message: 'spawn timeout' });
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree }, exec);
    expect(kindOf(out, 'node_modules')).toBe('failed');
    expect(existsSync(path.join(worktree, 'node_modules'))).toBe(false);
  });
});

describe('review findings (tkt-608bf45ec6f6 round 1)', () => {
  it('links a declared directory FIRST, so an include match inside it cannot pre-create a real directory', () => {
    const { repo, worktree } = fixture({
      '.env': 'root',
      'node_modules/pkg/.env': 'shipped by a package',
      'node_modules/pkg/package.json': '{}',
      '.worktreeinclude': '.env\n',
      '.claude/settings.json': JSON.stringify({ worktree: { symlinkDirectories: ['node_modules'] } }),
    });
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(out, 'node_modules')).toBe('linked');
    expect(kindOf(out, '.env')).toBe('copied');
    expect(kindOf(out, 'node_modules/pkg/.env')).toBe('skipped');
    expect(provisionFailed(out)).toBe(false);
  });

  it('refuses to copy a file the WORKTREE does not ignore, even when the source checkout does', () => {
    const { repo, worktree } = fixture({ 'secrets.json': '{}', '.worktreeinclude': 'secrets.json\n' });
    // Ignored only in the source checkout's working tree — the worktree was cut from the commit.
    writeFileSync(path.join(repo, '.gitignore'), '.env\nlocal/\nnode_modules\n.claude/worktrees\nsecrets.json\n');
    const out = provisionWorktree({ repoDir: repo, worktreeDir: worktree });
    expect(kindOf(out, 'secrets.json')).toBe('failed');
    expect(existsSync(path.join(worktree, 'secrets.json'))).toBe(false);
  });

  it.each([
    ['a plain directory outside the repository', (f: ReturnType<typeof fixture>) => { const d = path.join(f.root, 'plain'); mkdirSync(d); return d; }],
    ['the source checkout itself', (f: ReturnType<typeof fixture>) => f.repo],
  ])('refuses a worktreeDir that is %s', (_label, pick) => {
    const f = fixture({ '.env': 'x', '.worktreeinclude': '.env\n' });
    const target = pick(f);
    const out = provisionWorktree({ repoDir: f.repo, worktreeDir: target });
    expect(out.kind).toBe('refused');
    if (target !== f.repo) expect(existsSync(path.join(target, '.env'))).toBe(false);
  });

  it('refuses a worktree that belongs to a different repository', () => {
    const a = fixture({ '.env': 'x', '.worktreeinclude': '.env\n' });
    const b = fixture({});
    expect(provisionWorktree({ repoDir: a.repo, worktreeDir: b.worktree }).kind).toBe('refused');
    expect(existsSync(path.join(b.worktree, '.env'))).toBe(false);
  });
});

describe('round trip: `ticket-workflow worktree` creates, then provisions from the same declaration', () => {
  it('drives the real create and provision chain, leaving the declared files in the new worktree', async () => {
    const { repo } = fixture({
      '.env': 'SECRET=1',
      'node_modules/pkg/index.js': '',
      '.worktreeinclude': '.env\n',
      '.claude/settings.json': JSON.stringify({ worktree: { symlinkDirectories: ['node_modules'] } }),
    });
    const before = process.exitCode;
    process.exitCode = undefined;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await cmdWorktree(['--branch', 'feat/tkt-1-x', '--repo', repo], {
        fetchTicket: getTicket, create: createWorktree, provision: provisionWorktree,
      });
    } finally {
      log.mockRestore();
    }
    const created = path.join(repo, '.claude', 'worktrees', 'tkt-1-x');
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(path.join(created, '.env'), 'utf8')).toBe('SECRET=1');
    expect(lstatSync(path.join(created, 'node_modules')).isSymbolicLink()).toBe(true);
    process.exitCode = before;
  });
});
