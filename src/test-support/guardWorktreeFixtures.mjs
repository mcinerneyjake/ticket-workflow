// Real repos with real linked worktrees, shared by the guard-worktree suites. A stubbed worktreeKind
// would make every case a test of the stub: git is the only authority on "is this a linked worktree".
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { worktreeKind } from '../../hooks/lib/worktree.mjs';

export const SID = 'ses-0123456789abcdef';
export const TICKET = 'tkt-abcdef123456';

export const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function seedRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main', '.'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  writeFileSync(path.join(dir, 'tracked.txt'), 'v1\n');
  writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
  git(['add', 'tracked.txt', '.gitignore'], dir);
  git(['commit', '-qm', 'init'], dir);
}

export function buildFixtures() {
  const root = mkdtempSync(path.join(tmpdir(), 'tw-wtguard-'));

  const primary = path.join(root, 'primary');
  seedRepo(primary);
  mkdirSync(path.join(primary, 'ignored'));
  writeFileSync(path.join(primary, 'ignored', 'note.txt'), 'x\n');

  const linked = path.join(root, 'linked');
  git(['worktree', 'add', '-q', '-b', 'side', linked], primary);

  // The shape EnterWorktree produces: a worktree NESTED inside the primary's own tree. It is still a
  // linked checkout, and reading it as "inside the primary, therefore blocked" would make the guard
  // forbid the only thing it tells you to do.
  const nested = path.join(primary, '.claude', 'worktrees', TICKET);
  git(['worktree', 'add', '-q', '-b', 'nested', nested], primary);

  const plain = path.join(root, 'plain');
  mkdirSync(plain);

  const foreign = path.join(root, 'foreign');
  seedRepo(foreign);
  const foreignWt = path.join(foreign, '.claude', 'worktrees', TICKET);
  git(['worktree', 'add', '-q', '-b', 'fside', foreignWt], foreign);

  symlinkSync(path.join(primary, 'tracked.txt'), path.join(linked, 'link-to-primary.txt'));
  symlinkSync(path.join(primary, 'not-yet.txt'), path.join(linked, 'dangling-into-primary'));
  // The worktree provisioning every repo's CLAUDE.md prescribes: node_modules linked to the primary's.
  mkdirSync(path.join(foreign, 'node_modules'));
  symlinkSync(path.join(foreign, 'node_modules'), path.join(foreignWt, 'node_modules'));
  // Dangling links whose RELATIVE target only resolves correctly from the link's real directory,
  // and one sitting in a primary that points outside every repo.
  mkdirSync(path.join(foreign, 'node_modules', '.bin'));
  symlinkSync('../../escaped.txt', path.join(foreign, 'node_modules', '.bin', 'dl'));
  mkdirSync(path.join(root, 'outside'));
  symlinkSync(path.join(root, 'outside', 'nothere.txt'), path.join(primary, 'dang-out'));

  // A primary whose path contains a SPACE, with a real directory sitting at the point an unquoted
  // operand truncates to. Without that neighbour the truncated path resolves to nothing and the
  // guard blocks for the wrong reason, so the case would pass while proving nothing.
  const spaced = path.join(root, 'my repo');
  mkdirSync(path.join(root, 'my'));
  seedRepo(spaced);
  const spacedWt = path.join(root, 'spaced-wt');
  git(['worktree', 'add', '-q', '-b', 'spacedside', spacedWt], spaced);

  mkdirSync(path.join(primary, 'src'));
  writeFileSync(path.join(primary, 'src', 'deep.txt'), 'x\n');

  return { root, primary, linked, nested, plain, foreign, foreignWt, spaced, spacedWt };
}

/**
 * REAL detection, memoised per directory: three `git rev-parse` spawns per decide() across every row
 * starved the slower suites sharing the run. The fixtures never change kind, so the cache masks nothing.
 */
const kindCache = new Map();
export const realKind = (dir) => {
  if (!kindCache.has(dir)) kindCache.set(dir, worktreeKind(dir));
  return kindCache.get(dir);
};
