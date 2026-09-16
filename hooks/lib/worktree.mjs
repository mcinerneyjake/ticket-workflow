// Which kind of checkout a directory is: the primary one, a linked worktree, or no repo at all.
// Extracted from warn-stale-worktree's gatherFacts (tkt-1d647fd64ce4) so the staleness REPORTER and
// the worktree GUARD answer that question through one implementation. Two copies would drift on
// exactly the edge cases the guard fails closed on, and a guard that disagreed with the reporter
// about which checkout it was in would block work the reporter calls fine.

import { realpathSync } from 'node:fs';
import { tryGit } from './default-branch.mjs';

const NOT_A_REPO = /not a git repository|does not appear to be a git repository/i;

// { kind, probeError } — kind is 'linked' | 'primary' | 'none' | null.
//
// `null` is NEVER folded into 'none', and that split is the whole point of this function. Both mean
// "not a linked worktree" to the reporter, but they are opposites to the guard: 'none' is a write
// outside any repo, which is allowed, while `null` is git failing to answer, which must block. A
// poisoned GIT_CONFIG_PARAMETERS or a safe.directory refusal would otherwise disable the guard
// silently — the permissive answer, arrived at by a probe that did not run.
export function worktreeFacts(cwd) {
  const inside = tryGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside.err) {
    // Genuinely outside a repo is the common case; any other git failure means the check could not
    // run, which is a different answer and must stay one.
    if (NOT_A_REPO.test(inside.err)) return { kind: 'none' };
    return { kind: null, probeError: firstLine(inside.err) };
  }
  if (inside.out !== 'true') return { kind: 'none' };

  const gitDir = tryGit(['rev-parse', '--absolute-git-dir'], cwd);
  // --path-format=absolute needs git >= 2.31; --git-common-dir alone is older and may be relative,
  // so it is resolved against the worktree root when needed.
  let commonDir = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (commonDir.err) {
    const relative = tryGit(['rev-parse', '--git-common-dir'], cwd);
    const root = tryGit(['rev-parse', '--show-toplevel'], cwd);
    commonDir =
      relative.out && root.out
        ? { out: relative.out.startsWith('/') ? relative.out : `${root.out}/${relative.out}` }
        : relative;
  }
  if (gitDir.err || commonDir.err) {
    return { kind: null, probeError: firstLine(gitDir.err || commonDir.err) };
  }
  // A linked worktree's own git dir sits UNDER the common dir; the primary's IS it.
  return { kind: resolveReal(gitDir.out) === resolveReal(commonDir.out) ? 'primary' : 'linked' };
}

export function worktreeKind(cwd) {
  return worktreeFacts(cwd).kind;
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].slice(0, 200);
}

function resolveReal(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
