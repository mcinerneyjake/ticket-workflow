import { copyFileSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, type Stats } from 'node:fs';
import path from 'node:path';
import { defaultExec, isRecord, type Exec } from '../audit/types.js';

/**
 * Provision a new worktree with what a checkout does not carry (`tkt-608bf45ec6f6`).
 *
 * The declaration is Claude Code's own: `.worktreeinclude` and `worktree.symlinkDirectories` in
 * `.claude/settings.json`. The CLI applies them only to worktrees IT creates, so this reads the same
 * two files with the same semantics for every other path (`git worktree add`, night runs, foreign
 * repos). Measured against Claude Code 2.1.273: an include entry is copied only when git also ignores
 * it, and `settings.local.json` is deliberately NOT copied — the CLI resolves it to the main checkout.
 */

export const INCLUDE_FILE = '.worktreeinclude';
export const SETTINGS_FILE = '.claude/settings.json';

export type ProvisionEntry =
  | { readonly kind: 'copied' | 'linked' | 'present'; readonly path: string }
  | { readonly kind: 'skipped'; readonly path: string; readonly reason: string }
  | { readonly kind: 'failed'; readonly path: string; readonly reason: string };

export type ProvisionOutcome =
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'provisioned'; readonly declared: boolean; readonly entries: readonly ProvisionEntry[] };

export interface ProvisionOptions {
  /** The checkout the declaration and the source files are read from. */
  readonly repoDir: string;
  readonly worktreeDir: string;
}

/** True when the caller must not treat the worktree as ready. */
export function provisionFailed(outcome: ProvisionOutcome): boolean {
  return outcome.kind === 'refused' || outcome.entries.some((e) => e.kind === 'failed');
}

type Git = { kind: 'ok'; stdout: string } | { kind: 'status'; status: number } | { kind: 'undetermined'; why: string };

function runGit(exec: Exec, cwd: string, args: readonly string[], input?: string): Git {
  const r = exec('git', args, { cwd, ...(input !== undefined ? { input } : {}) });
  if (r.kind === 'absent') return { kind: 'undetermined', why: 'git is not on PATH' };
  if (r.kind === 'error') return { kind: 'undetermined', why: r.message };
  if (r.ok) return { kind: 'ok', stdout: r.stdout };
  // An exec that cannot report its exit code cannot tell "not ignored" (1) from a fatal error.
  if (typeof r.status !== 'number') return { kind: 'undetermined', why: `git ${args[0]} failed with no exit status` };
  return { kind: 'status', status: r.status };
}

const nulList = (s: string): string[] => s.split('\0').filter((p) => p !== '');

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw err;
  }
}

/** A link spelled through another path to the same directory (`/var` vs `/private/var`) is the same link. */
function sameTarget(link: string, target: string): boolean {
  try {
    return realpathSync(link) === realpathSync(target);
  } catch {
    return false;
  }
}

/** Relative, no `..`, not absolute — a declaration must not name anything outside the checkout. */
function unsafeRelative(rel: string): boolean {
  return rel === '' || path.isAbsolute(rel) || rel.split(/[/\\]/).some((seg) => seg === '..');
}

/**
 * True when writing `dest` would land outside the worktree — the nearest existing ancestor is resolved
 * through symlinks, so a committed symlinked directory cannot redirect a copy into another tree.
 */
function escapesWorktree(dest: string, worktreeReal: string): boolean {
  let dir = path.dirname(dest);
  for (;;) {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') return true;
      const parent = path.dirname(dir);
      if (parent === dir) return true;
      dir = parent;
      continue;
    }
    return real !== worktreeReal && !real.startsWith(worktreeReal + path.sep);
  }
}

function includedFiles(exec: Exec, repoDir: string): { kind: 'ok'; ignored: string[]; unignored: string[] } | { kind: 'refused'; reason: string } {
  // --others excludes tracked files, which the checkout already carries.
  const matched = runGit(exec, repoDir, [
    'ls-files', '-z', '--others', '--ignored', `--exclude-from=${path.join(repoDir, INCLUDE_FILE)}`,
  ]);
  if (matched.kind !== 'ok') {
    return { kind: 'refused', reason: `could not list ${INCLUDE_FILE} matches: ${matched.kind === 'undetermined' ? matched.why : `exit ${matched.status}`}` };
  }
  const candidates = nulList(matched.stdout);
  if (candidates.length === 0) return { kind: 'ok', ignored: [], unignored: [] };

  const checked = ignoredIn(exec, repoDir, candidates);
  if (checked.kind === 'refused') return checked;
  return {
    kind: 'ok',
    ignored: candidates.filter((c) => checked.set.has(c)),
    unignored: candidates.filter((c) => !checked.set.has(c)),
  };
}

function ignoredIn(exec: Exec, cwd: string, paths: readonly string[]): { kind: 'ok'; set: Set<string> } | { kind: 'refused'; reason: string } {
  if (paths.length === 0) return { kind: 'ok', set: new Set() };
  // Exit 1 is the legitimate "none of these is ignored"; anything else unexplained is undetermined.
  const checked = runGit(exec, cwd, ['check-ignore', '-z', '--stdin'], paths.join('\0') + '\0');
  if (checked.kind === 'undetermined' || (checked.kind === 'status' && checked.status !== 1)) {
    return { kind: 'refused', reason: `could not tell which paths git ignores in ${cwd}: ${checked.kind === 'undetermined' ? checked.why : `exit ${checked.status}`}` };
  }
  return { kind: 'ok', set: new Set(checked.kind === 'ok' ? nulList(checked.stdout) : []) };
}

/** Null when `worktreeReal` is the root of a LINKED worktree sharing `repoDir`'s repository. */
function linkedWorktreeProblem(exec: Exec, repoDir: string, worktreeReal: string): string | null {
  const common = (cwd: string) => runGit(exec, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const top = runGit(exec, worktreeReal, ['rev-parse', '--show-toplevel']);
  const [ours, theirs] = [common(repoDir), common(worktreeReal)];
  if (top.kind !== 'ok' || ours.kind !== 'ok' || theirs.kind !== 'ok') return `${worktreeReal} is not a git worktree that could be verified`;
  const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
  if (real(top.stdout.trim()) !== worktreeReal) return `${worktreeReal} is not the root of a worktree`;
  if (real(ours.stdout.trim()) !== real(theirs.stdout.trim())) return `${worktreeReal} belongs to a different repository`;
  if (real(repoDir) === worktreeReal) return `${worktreeReal} is the source checkout itself, not a new worktree`;
  return null;
}

function readSymlinkDirectories(repoDir: string): { kind: 'ok'; dirs: string[] } | { kind: 'refused'; reason: string } {
  let raw: string;
  try {
    raw = readFileSync(path.join(repoDir, SETTINGS_FILE), 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { kind: 'ok', dirs: [] };
    return { kind: 'refused', reason: `could not read ${SETTINGS_FILE}: ${errorCode(err) ?? String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'refused', reason: `${SETTINGS_FILE} is not valid JSON, so worktree.symlinkDirectories cannot be read` };
  }
  if (!isRecord(parsed)) return { kind: 'refused', reason: `${SETTINGS_FILE} is not a JSON object` };
  const worktree = parsed.worktree;
  if (worktree === undefined) return { kind: 'ok', dirs: [] };
  if (!isRecord(worktree)) return { kind: 'refused', reason: `${SETTINGS_FILE} "worktree" is not an object` };
  const dirs = worktree.symlinkDirectories;
  if (dirs === undefined) return { kind: 'ok', dirs: [] };
  if (!Array.isArray(dirs) || !dirs.every((d): d is string => typeof d === 'string')) {
    return { kind: 'refused', reason: `${SETTINGS_FILE} worktree.symlinkDirectories must be an array of strings` };
  }
  return { kind: 'ok', dirs };
}

function copyEntry(repoDir: string, worktreeDir: string, worktreeReal: string, rel: string): ProvisionEntry {
  const src = path.join(repoDir, rel);
  const dest = path.join(worktreeDir, rel);
  try {
    if (lstatSync(src).isSymbolicLink()) return { kind: 'failed', path: rel, reason: 'source is a symlink, which is never copied' };
    if (lstatOrNull(dest) !== null) return { kind: 'present', path: rel };
    if (escapesWorktree(dest, worktreeReal)) return { kind: 'failed', path: rel, reason: 'destination resolves outside the worktree' };
    mkdirSync(path.dirname(dest), { recursive: true });
    // EXCL: a concurrent writer or a dangling symlink at dest fails the copy instead of being overwritten.
    copyFileSync(src, dest, constants.COPYFILE_EXCL);
    return { kind: 'copied', path: rel };
  } catch (err) {
    return { kind: 'failed', path: rel, reason: errorCode(err) ?? String(err) };
  }
}

function linkEntry(exec: Exec, repoDir: string, worktreeDir: string, worktreeReal: string, rel: string): ProvisionEntry {
  if (unsafeRelative(rel)) return { kind: 'failed', path: rel, reason: 'must be a relative path inside the repository' };
  const src = path.join(repoDir, rel);
  const dest = path.join(worktreeDir, rel);
  try {
    if (lstatOrNull(src) === null) return { kind: 'skipped', path: rel, reason: 'absent in the source checkout' };
    const existing = lstatOrNull(dest);
    if (existing !== null) {
      if (existing.isSymbolicLink() && sameTarget(dest, src)) return { kind: 'present', path: rel };
      // The late-link trap: `ln -s` onto an existing directory nests the link inside it and exits 0.
      return { kind: 'failed', path: rel, reason: 'something other than the link already exists there' };
    }
    if (escapesWorktree(dest, worktreeReal)) return { kind: 'failed', path: rel, reason: 'destination resolves outside the worktree' };
    mkdirSync(path.dirname(dest), { recursive: true });
    symlinkSync(src, dest, 'dir');
  } catch (err) {
    return { kind: 'failed', path: rel, reason: errorCode(err) ?? String(err) };
  }

  // `node_modules/` (trailing slash) ignores a directory but not a symlink to one, so an unignored link
  // would sit untracked — one path-scoped `git add` from a commit, and it blocks `git worktree remove`.
  const ignored = runGit(exec, worktreeDir, ['check-ignore', '-q', '--', rel]);
  if (ignored.kind === 'ok') return { kind: 'linked', path: rel };
  try {
    unlinkSync(dest);
  } catch (err) {
    return { kind: 'failed', path: rel, reason: `git does not confirm the link is ignored, and removing it failed (${errorCode(err) ?? String(err)}) — remove it by hand` };
  }
  if (ignored.kind === 'status' && ignored.status === 1) {
    return { kind: 'failed', path: rel, reason: 'git does not ignore the link (a trailing-slash pattern matches directories only); link removed' };
  }
  return { kind: 'failed', path: rel, reason: `could not confirm git ignores the link (${ignored.kind === 'undetermined' ? ignored.why : `exit ${ignored.status}`}); link removed` };
}

export function provisionWorktree(opts: ProvisionOptions, exec: Exec = defaultExec): ProvisionOutcome {
  const { worktreeDir } = opts;
  // Every path below is root-relative; `ls-files` run from a subdirectory would list only that subtree.
  const top = runGit(exec, opts.repoDir, ['rev-parse', '--show-toplevel']);
  if (top.kind !== 'ok') {
    return { kind: 'refused', reason: `could not resolve the repository root of ${opts.repoDir}: ${top.kind === 'undetermined' ? top.why : `exit ${top.status}`}` };
  }
  const repoDir = top.stdout.trim();
  let worktreeReal: string;
  try {
    worktreeReal = realpathSync(worktreeDir);
  } catch (err) {
    return { kind: 'refused', reason: `worktree ${worktreeDir} is not readable: ${errorCode(err) ?? String(err)}` };
  }
  const notWorktree = linkedWorktreeProblem(exec, repoDir, worktreeReal);
  if (notWorktree !== null) return { kind: 'refused', reason: notWorktree };

  const links = readSymlinkDirectories(repoDir);
  if (links.kind === 'refused') return links;

  let includeStat: Stats | null;
  try {
    includeStat = lstatOrNull(path.join(repoDir, INCLUDE_FILE));
  } catch (err) {
    return { kind: 'refused', reason: `could not read ${INCLUDE_FILE}: ${errorCode(err) ?? String(err)}` };
  }
  if (includeStat !== null && !includeStat.isFile()) {
    return { kind: 'refused', reason: `${INCLUDE_FILE} exists but is not a regular file` };
  }
  const includeDeclared = includeStat !== null;

  // Links first, as Claude Code orders them: a copy under a declared directory would otherwise create
  // a real directory there, which the link can then never replace.
  const entries: ProvisionEntry[] = links.dirs.map((rel) => linkEntry(exec, repoDir, worktreeDir, worktreeReal, rel));
  if (includeDeclared) {
    const files = includedFiles(exec, repoDir);
    if (files.kind === 'refused') return files;
    const underLink = (rel: string) => links.dirs.some((d) => rel.startsWith(`${d.replace(/\/+$/, '')}/`));
    const outside = (rel: string) => escapesWorktree(path.join(worktreeDir, rel), worktreeReal);
    // Escaping paths are settled first: git refuses outright to judge a path beyond a symlink.
    for (const rel of files.ignored) {
      if (!underLink(rel) && outside(rel)) entries.push({ kind: 'failed', path: rel, reason: 'destination resolves outside the worktree' });
    }
    const toCopy = files.ignored.filter((rel) => !outside(rel));
    const ignoredThere = ignoredIn(exec, worktreeDir, toCopy);
    if (ignoredThere.kind === 'refused') return ignoredThere;
    for (const rel of toCopy) {
      // The worktree is cut from a commit, so its ignore rules can differ from the source's working tree.
      entries.push(ignoredThere.set.has(rel)
        ? copyEntry(repoDir, worktreeDir, worktreeReal, rel)
        : { kind: 'failed', path: rel, reason: 'the worktree does not ignore it, so a copy would sit untracked' });
    }
    for (const rel of files.ignored.filter(underLink)) entries.push({ kind: 'skipped', path: rel, reason: 'inside a linked directory' });
    for (const rel of files.unignored) entries.push({ kind: 'skipped', path: rel, reason: 'matches but is not gitignored, and only ignored files are copied' });
  }

  return { kind: 'provisioned', declared: includeDeclared || links.dirs.length > 0, entries };
}
