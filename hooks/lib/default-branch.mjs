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

const WELL_KNOWN = ['main', 'master'];

function refExists(ref, cwd, git) {
  return Boolean(git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).out);
}

/**
 * The repo's default branch as a REF that exists (`origin/main`, `master`, …), or null.
 * Used by the staleness reporter to pick something to diff against, where any plausible ref is fine.
 *
 * NOT suitable for deciding which branch is PROTECTED — see protectedBranches, which is deliberately
 * stricter, because there a wrong answer is a bypass rather than a slightly-off diff.
 */
export function resolveBaseRef(cwd, git = tryGit) {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).out;
  const candidates = [...(head ? [head] : []), 'origin/main', 'origin/master', 'main', 'master'];
  for (const ref of candidates) {
    if (refExists(ref, cwd, git)) return ref;
  }
  return null;
}

/**
 * Which branch names this repo protects, as an array — or **null** meaning "cannot determine",
 * which callers must treat as fail-closed, never as "nothing is protected".
 *
 * Stricter than resolveBaseRef's first-match ladder on purpose. That ladder tries `origin/main`
 * before `origin/master`, so a repo mid-rename — real default `master`, a stale `origin/main` still
 * present, `origin/HEAD` unset (any clone predating git 2.46, or after `symbolic-ref -d`) — would
 * report `main`, leaving the real default unguarded AND blocking an ordinary branch. Here that case
 * is ambiguous, so it refuses.
 *
 * The last resort is the well-known names rather than null: a repo whose default cannot be
 * identified at all (say `develop`, remote not yet fetched) is HEALTHY, and returning null there
 * would block every commit in it. That is disproportionate for a hook that runs machine-wide, and it
 * is not a fail-open — protecting {main, master} is exactly what this guard did before it could
 * resolve anything. The residual gap (a `develop` default is unguarded until fetched) is what
 * TICKET_WORKFLOW_PROTECTED_BRANCH is for.
 */
export function protectedBranches(cwd, git = tryGit, env = process.env) {
  const override = env.TICKET_WORKFLOW_PROTECTED_BRANCH?.trim();
  if (override) {
    // An override naming a branch this repo does not have protects NOTHING, and the variable is
    // process-wide — so a value set for one repo would silently disarm the guard in every other one.
    // Unverifiable override = cannot check = refuse.
    const known = refExists(override, cwd, git) || refExists(`origin/${override}`, cwd, git);
    return known ? [override] : null;
  }

  // origin/HEAD names the repo's ACTUAL default; when it is set there is nothing to guess.
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).out;
  if (head) return [head.replace(/^origin\//, '')];

  const remote = WELL_KNOWN.filter((n) => refExists(`origin/${n}`, cwd, git));
  if (remote.length === 1) return remote;
  if (remote.length > 1) return null; // both present, origin/HEAD unset — genuinely ambiguous

  const local = WELL_KNOWN.filter((n) => refExists(n, cwd, git));
  if (local.length > 0) return local; // protect every well-known branch that exists here

  return [...WELL_KNOWN];
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
