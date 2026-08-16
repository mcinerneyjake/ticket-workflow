import { execFileSync } from 'node:child_process';

/** Run git, returning trimmed stdout or an error string — never throwing. */
export function tryGit(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024, // a big repo's diff must not truncate into a false "no drift"
    });
    return { out: out.trim() };
  } catch (e) {
    return { err: String(e?.stderr || e?.message || e).trim() };
  }
}

/**
 * The repo's default branch, as a REF that exists (`origin/main`, `master`, …), or null.
 *
 * origin/HEAD first: it names the repo's ACTUAL default branch, so a repo on `develop` is not
 * permanently alarmed about a missing origin/main. Local main/master last, for repos with no
 * remote at all.
 *
 * One ladder, used by both the staleness reporter and the commit guard — two copies would drift,
 * and a guard disagreeing with the reporter about which branch is protected is the kind of split
 * that hides for weeks.
 */
export function resolveBaseRef(cwd, git = tryGit) {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).out;
  const candidates = [...(head ? [head] : []), 'origin/main', 'origin/master', 'main', 'master'];
  for (const ref of candidates) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).out) return ref;
  }
  return null;
}

/**
 * The default branch as a bare NAME (`main`, `master`), for comparing against the current branch.
 * `TICKET_WORKFLOW_PROTECTED_BRANCH` overrides it outright, for repos the ladder cannot speak for.
 *
 * Returns null when it cannot be determined — callers must treat that as "cannot check", never as
 * "nothing is protected".
 */
export function protectedBranchName(cwd, git = tryGit, env = process.env) {
  const override = env.TICKET_WORKFLOW_PROTECTED_BRANCH?.trim();
  if (override) return override;
  const ref = resolveBaseRef(cwd, git);
  return ref ? ref.replace(/^origin\//, '') : null;
}

/**
 * Does this repo have a remote configured?
 *
 * FAILS CLOSED — true on any error, non-zero exit, or unreadable output. Only a clean `git remote`
 * that succeeds with empty output may report false, because false is the permissive answer here: it
 * exempts the repo from the commit-to-default-branch rule. Otherwise every way of breaking git
 * becomes a bypass, which is the hole tkt-fbc74a3252fe closed for branch resolution.
 */
export function hasRemote(cwd, git = tryGit) {
  const { out, err } = git(['remote'], cwd);
  if (err !== undefined) return true;
  if (typeof out !== 'string') return true;
  return out.length > 0;
}
