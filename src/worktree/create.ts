import { defaultExec, type Exec } from '../audit/types.js';

/**
 * Create an isolated git worktree, so two concurrent sessions in one repository cannot share a
 * working tree (`tkt-d330a4b106b9`).
 *
 * Claude Code's own EnterWorktree isolates only the repo a session was STARTED in. On a machine
 * where one board serves every repository, sessions start in the board's repo and edit sibling
 * repos — which get no isolation at all. That is not hypothetical: two sessions shared one checkout
 * of a sibling repo, and a branch switch by one moved HEAD out from under the other while it held a
 * full ticket's work uncommitted.
 *
 * Nothing here is specific to any one repository. Branch prefixes and the base branch are RESOLVED
 * or supplied, never assumed — a package that ships to every repo must not hand them a convention
 * that exists in one (the mistake corrected in #55).
 */

/** Where worktrees live, relative to the repo root. */
export const WORKTREE_DIR = '.claude/worktrees';

/**
 * INSIDE the repo, not beside it, and that is load-bearing rather than cosmetic: Node resolves
 * upward, so a nested worktree finds the main checkout's `node_modules` and the gate runs with no
 * install. A sibling directory would need a full install per worktree.
 */
export function worktreePath(name: string): string {
  return `${WORKTREE_DIR}/${name}`;
}

export type BranchPrefix = 'fix' | 'feat' | 'task' | 'chore';

/** Ticket type → branch prefix. Exported so a caller can map its own vocabulary onto it. */
export const PREFIX_BY_TYPE: Readonly<Record<string, BranchPrefix>> = {
  bug: 'fix',
  feature: 'feat',
  task: 'task',
  chore: 'chore',
};

/**
 * The candidate ladder for the base ref, most-specific first.
 *
 * Duplicated in spirit from hooks/lib/default-branch.mjs, which cannot be imported here — `src` is
 * TypeScript-only and the hooks ship as plain .mjs. `create.test.ts` imports that module and asserts
 * both ladders agree, so the copy is guarded by a failing test rather than by a comment asking
 * someone to keep them in sync.
 *
 * `origin/HEAD` first because it is the repo's own answer. The local fallbacks matter more than they
 * look: measured across nine repositories, three had NO remote at all, so a remote-only resolver
 * would refuse in exactly the repositories where a local worktree is the only isolation available.
 */
export function baseCandidates(originHead: string | null): readonly string[] {
  return [...(originHead ? [originHead] : []), 'origin/main', 'origin/master', 'main', 'master'];
}

/** Lowercase, symbols dropped, joined by hyphens, capped at `words` words. */
export function slugify(title: string, words = 5): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, words)
    .join('-');
}

export function branchName(prefix: string, id: string, title: string): string {
  const slug = slugify(title);
  return slug === '' ? `${prefix}/${id}` : `${prefix}/${id}-${slug}`;
}

export interface CreateOptions {
  readonly repoDir: string;
  readonly branch: string;
  /** Explicit base ref. When absent it is resolved, and an unresolvable base REFUSES. */
  readonly base?: string;
  /** Directory name under `.claude/worktrees/`. Defaults to the branch's last path segment. */
  readonly name?: string;
}

export type CreateOutcome =
  | { readonly kind: 'created'; readonly path: string; readonly branch: string; readonly base: string }
  | { readonly kind: 'refused'; readonly reason: string };

function git(exec: Exec, repoDir: string, args: readonly string[]): { ok: boolean; out: string; absent: boolean } {
  const r = exec('git', args, { cwd: repoDir });
  if (r.kind === 'absent') return { ok: false, out: '', absent: true };
  if (r.kind === 'error') return { ok: false, out: '', absent: false };
  return { ok: r.ok, out: r.stdout.trim(), absent: false };
}

/**
 * Resolve the ref a new worktree should be cut from, or null when it cannot be determined.
 *
 * Null is a refusal, never a default. Guessing `main` in a repo whose default is `master` would cut
 * the branch from the wrong history and the mistake would only surface at review time.
 */
export function resolveBase(exec: Exec, repoDir: string): string | null {
  const head = git(exec, repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const originHead = head.ok && head.out !== '' ? head.out : null;
  for (const ref of baseCandidates(originHead)) {
    if (git(exec, repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok) return ref;
  }
  return null;
}

/**
 * Every refusal below is a case where proceeding would either destroy work or produce a worktree
 * that silently is not what was asked for. `git worktree add` itself refuses an existing branch or
 * path, but refusing FIRST is what makes the message name the situation rather than surface git's.
 */
export function createWorktree(opts: CreateOptions, exec: Exec = defaultExec): CreateOutcome {
  const { repoDir, branch } = opts;
  const name = opts.name ?? branch.split('/').pop() ?? branch;
  const relPath = worktreePath(name);

  // Git absent is BLOCKED, not "assume it worked" — the whole point is that a wrong answer here
  // costs someone their uncommitted work.
  const top = git(exec, repoDir, ['rev-parse', '--show-toplevel']);
  if (top.absent) return { kind: 'refused', reason: 'git is not on PATH, so no worktree can be created' };
  if (!top.ok) return { kind: 'refused', reason: `${repoDir} is not inside a git repository` };

  if (git(exec, repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
    return {
      kind: 'refused',
      reason: `branch ${branch} already exists — check it out, or pass --branch with a different name`,
    };
  }

  const existing = git(exec, repoDir, ['worktree', 'list', '--porcelain']);
  if (existing.ok && existing.out.split('\n').some((l) => l.startsWith('worktree ') && l.endsWith(`/${relPath}`))) {
    return { kind: 'refused', reason: `a worktree already exists at ${relPath}` };
  }

  const base = opts.base ?? resolveBase(exec, repoDir);
  if (base === null) {
    return {
      kind: 'refused',
      reason: 'could not resolve a base branch (no origin/HEAD, main or master) — pass --base <ref>',
    };
  }
  // An explicitly-passed base is verified too. A typo'd --base would otherwise reach git as a
  // pathspec and produce a confusing error about a file.
  if (!git(exec, repoDir, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).ok) {
    return { kind: 'refused', reason: `base ref ${base} does not exist in this repository` };
  }

  const add = git(exec, repoDir, ['worktree', 'add', '-b', branch, relPath, base]);
  if (!add.ok) return { kind: 'refused', reason: `git worktree add failed: ${add.out || 'no output'}` };

  return { kind: 'created', path: relPath, branch, base };
}
