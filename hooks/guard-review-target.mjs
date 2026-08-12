#!/usr/bin/env node
// UserPromptExpansion(code-review|security-review) guardrail — wired in ~/.claude/settings.json.
//
// Stops a review from silently reviewing the WRONG REPOSITORY (tkt-1a9dd9b349f3). A review with no
// explicit target resolves its diff from the SESSION's repo. When that repo is clean and level with
// its default branch there is nothing to review, so the review falls back to the last commit — and
// returns confident findings about code nobody in the session wrote. On 2026-08-12 that produced six
// verified-looking findings against an already-merged PR while the real work sat in another repo.
// The only signal was one line of prose, which is the fail-open shape: "reviewed nothing relevant"
// and "reviewed your work and it is fine" rendered identically.
//
// WHY THIS EVENT: a USER-TYPED slash command never reaches PreToolUse. UserPromptExpansion is the
// documented event for that path ("When a user-typed slash command expands into a prompt"), and its
// matcher key is `command_name`. Verified against the installed CLI's own hook docs, with controls.
//
// PROTOCOL: read the payload as JSON on stdin; exit 0 to allow, exit 2 to block. Exit 2 is the
// documented contract for this event ("block expansion and show stderr to user only") and matches
// guard-bash / guard-ticket. Do NOT switch this to a `decision: "block"` JSON body.
//
// FAIL DIRECTION — closed, like guard-ticket rather than guard-bash. The settings matcher routes only
// review commands here, so refusing when the repo state cannot be determined cannot wedge unrelated
// work; it can only make the operator name a target. "I could not check" must never render as "I
// checked and it is fine", which is the exact defect this guard exists to close.
//
// THE ESCAPE IS DELIBERATE AND CHEAP: an explicit target in the args is checked BEFORE any git call,
// so a named target always runs — even in a broken git environment. A named target cannot be silently
// inferred, so there is nothing for this guard to protect against.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// `/ultrareview` is a deprecated alias for `/code-review ultra`; it resolves the same way, so it
// carries the same defect and is guarded too.
const REVIEW_COMMANDS = /^(?:code-review|security-review|ultrareview)$/;

// Tokens that modify HOW a review runs, never WHAT it reviews. Everything else is a target.
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

const ESCAPES =
  'Either (a) pass an explicit target — `/code-review <PR#|branch|path>` — or (b) start the session ' +
  'in the repository whose code changed, since a review with no target always resolves against the ' +
  "SESSION's repo, not whatever path was mentioned in conversation.";

export function namesExplicitTarget(args) {
  if (typeof args !== 'string') return false;
  return args
    .split(/\s+/)
    .filter(Boolean)
    .some((tok) => !tok.startsWith('-') && !EFFORT_LEVELS.has(tok.toLowerCase()));
}

export function reasonNothingToReview(base) {
  return (
    `this repository is clean and has no commits against \`${base}\`, so there is no diff to review. ` +
    'A review started here would fall back to the last commit and report findings about already-merged ' +
    `code as if they were yours. ${ESCAPES}`
  );
}

export function reasonCannotCheck(why) {
  return (
    `the repository state could not be determined (${why}), so this guard cannot tell whether the ` +
    'review would resolve a real diff or silently fall back to the last commit. Refusing rather than ' +
    `guessing, because a wrong-repo review reads exactly like a clean one. ${ESCAPES}`
  );
}

/**
 * `getRepo` is a thunk so the git calls never run on the paths that do not need them — an explicit
 * target short-circuits first, which is what keeps a broken git environment from blocking real work.
 */
export function decide(payload, getRepo) {
  const name = payload?.command_name;
  // Fail CLOSED: the matcher routed us here, so an unreadable command name is a review command.
  if (typeof name !== 'string') {
    return { blocked: true, reason: reasonCannotCheck('the hook payload carried no command name') };
  }
  if (!REVIEW_COMMANDS.test(name.replace(/^\//, ''))) return { blocked: false };

  if (namesExplicitTarget(payload?.command_args)) return { blocked: false };

  const repo = getRepo();
  if (repo?.determinate !== true) {
    return { blocked: true, reason: reasonCannotCheck(repo?.why ?? 'unknown') };
  }
  if (repo.dirty) return { blocked: false };
  if (repo.ahead > 0) return { blocked: false };
  return { blocked: true, reason: reasonNothingToReview(repo.base) };
}

/** Resolve what "the default branch" means here rather than assuming `main` — an unresolvable base
 *  is reported as indeterminate, never silently defaulted (a wrong base makes `ahead` meaningless). */
export function resolveBase(run) {
  const sym = run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (sym.status === 0) {
    const ref = sym.stdout.trim();
    if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length);
  }
  for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
    if (run(['rev-parse', '--verify', '--quiet', cand]).status === 0) return cand;
  }
  return null;
}

export function readRepoState(run) {
  const inside = run(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return { determinate: false, why: 'not inside a git working tree' };
  }
  const status = run(['status', '--porcelain']);
  if (status.status !== 0) return { determinate: false, why: '`git status` failed' };
  // Any modification or untracked file means there IS something to review — allow before the
  // more expensive base resolution, and before a missing remote can make us refuse.
  if (status.stdout.trim().length > 0) return { determinate: true, dirty: true };

  const base = resolveBase(run);
  if (!base) {
    return { determinate: false, why: 'no default branch (origin/HEAD, main, master) could be resolved' };
  }
  const ahead = run(['rev-list', '--count', `${base}..HEAD`]);
  if (ahead.status !== 0) return { determinate: false, why: `\`git rev-list ${base}..HEAD\` failed` };
  const raw = ahead.stdout.trim();
  // A digit test, not Number(): `Number('')` is 0, which would render "could not read" as "0 commits".
  if (!/^\d+$/.test(raw)) return { determinate: false, why: `unreadable commit count against ${base}` };
  return { determinate: true, dirty: false, base, ahead: Number(raw) };
}

function gitRunner() {
  return (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    // A failed spawn (git absent) sets `error` and leaves status null — map both to non-zero so the
    // caller reports indeterminate rather than reading a null status as success.
    if (r.error || r.status === null) return { status: 1, stdout: '' };
    return { status: r.status, stdout: r.stdout ?? '' };
  };
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    payload = {}; // unparseable → decide() fails closed
  }
  const { blocked, reason } = decide(payload, () => readRepoState(gitRunner()));
  if (blocked) {
    process.stderr.write(`[guard-review-target] Blocked: ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Run the I/O wiring only when invoked directly as the hook (not when imported by the test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
