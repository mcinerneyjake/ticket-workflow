#!/usr/bin/env node
// PreToolUse(Bash) guardrail — wired in .claude/settings.json.
//
// Blocks git commands that violate the CLAUDE.md "Branch, commit & PR workflow"
// BEFORE they run, instead of relying on the model to remember the rules every
// time:
//
//   1. Whole-tree staging — git add/stage -A | --all | . | * | :/  → forces
//      explicit, per-ticket file staging.
//   2. git commit -a / -am  → also stages the whole working tree, so it's
//      blocked on the same grounds as (1), regardless of branch.
//   3. git commit  while effectively on main → never commit directly to main.
//   4. git push    that targets main, or a bare push while on main → never
//      push to main (explicit non-main targets, deletes, and --tags are fine).
//
// SCOPE: this is a best-effort guard against the assistant's own predictable
// commands, NOT an adversarial sandbox. It does NOT defend against deliberately
// obscure forms — e.g. `git --git-dir <path> ...` global-option spoofing, env
// prefixes other than simple VAR=val, hiding a branch change behind a plain
// `git checkout <branch>` (only `switch` / `checkout -b` are tracked), or
// poisoning the unresolvable-dir slot, which every unknown `cd` target shares:
// `cd $A && git switch -c x && cd $B && git commit`. Defending those would mean
// reimplementing a shell parser; GitHub branch protection is the real backstop.
// See CLAUDE.md → Branch, commit & PR workflow.
//
// Protocol: read the hook payload as JSON on stdin, inspect
// `tool_input.command`. Exit 0 to allow; exit 2 to block (stderr is surfaced to
// Claude so it can self-correct). Anything unexpected → allow (fail open: a
// guardrail must never wedge legitimate work) — EXCEPT an unresolvable branch on
// commit/push, which fails CLOSED, because that is the one unknown that silently
// disables the rule it guards (tkt-fbc74a3252fe). The decision logic
// (parseGit / decide) is exported and pure so it can be unit-tested without
// spawning a subprocess; the stdin/exit wiring runs only when this file is
// executed directly as the hook entrypoint.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Pull the git subcommand + its args out of a single shell segment. The command
// WORD must be `git` (after stripping leading subshell/group punctuation and
// simple VAR=val env prefixes) — so data that merely mentions git, e.g.
// `echo "git add -A"`, is not treated as a git invocation. `-C <path>` is
// captured, not skipped: it names the repo the command acts on.
export function parseGit(segment) {
  const stripped = segment.trim().replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '');
  const tokens = stripped.split(/\s+/);
  let cmd = 0;
  while (cmd < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cmd])) cmd++; // env prefix
  if (tokens[cmd] !== 'git') return null;
  let i = cmd + 1;
  let repoDir = null;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '-C') { repoDir = tokens[i + 1] ?? null; i += 2; }
    else if (tokens[i] === '-c') { i += 2; } // -c takes a value we don't care about
    else i += 1;
  }
  if (i >= tokens.length) return null;
  return { sub: tokens[i], args: tokens.slice(i + 1), repoDir };
}

// null rather than a guess — a wrong dir judges one repo by another's branch.
function resolveDir(dir, target) {
  const quoted = /^["']/.test(target);
  const balanced = quoted && target.length > 1 && target.at(-1) === target[0];
  if (quoted && !balanced) return null; // whitespace-split upstream truncated a quoted path
  const t = balanced ? target.slice(1, -1) : target;
  if (!t || t.includes('$') || t.includes('*')) return null;
  if (t === '~') return homedir();
  if (t.startsWith('~/')) return join(homedir(), t.slice(2));
  if (t.startsWith('~')) return null; // ~user
  if (isAbsolute(t)) return t;
  return dir ? resolve(dir, t) : null;
}

// undefined = not a cd; null = unresolvable (`cd -`, bare `cd`) → currentBranch
// falls back to the hook's cwd rather than giving up.
export function cdTarget(segment, dir) {
  const stripped = segment.trim().replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '');
  const tokens = stripped.split(/\s+/);
  let cmd = 0;
  while (cmd < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cmd])) cmd++;
  if (tokens[cmd] !== 'cd') return undefined;
  const target = tokens[cmd + 1];
  if (!target || target.startsWith('-')) return null; // `cd`, `cd -`, `cd -P …`
  return resolveDir(dir, target);
}

// Args that stage the whole working tree rather than named paths.
function stagesEverything(args) {
  const blanket = new Set(['-A', '--all', '.', '*', "'*'", '"*"', ':/', './']);
  return args.some((a) => blanket.has(a));
}

// `git commit -a` / `-am` (a single-dash cluster containing 'a') or `--all`
// stages all tracked files, bypassing the add guard entirely.
function commitStagesAll(args) {
  return args.some(
    (a) => a === '--all' || (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes('a')),
  );
}

// True when a push would land on main: an explicit main refspec/target, or a
// bare push while on main (no explicit non-main target and not a delete/tags op).
function pushesMain(args, branch) {
  // Strip a leading `+` (force-refspec syntax) so `+main` is still seen as main.
  const positionals = args.filter((a) => !a.startsWith('-')).map((a) => a.replace(/^\+/, ''));
  const flags = args.filter((a) => a.startsWith('-'));
  const targetsMain = positionals.some(
    (a) => a === 'main' || a.endsWith(':main') || a.endsWith('/main'),
  );
  if (targetsMain) return true;
  // `HEAD` / `@` resolve to the current branch, so on main they push main —
  // `git push origin HEAD` while on main must not read as an explicit non-main
  // target.
  if (branch === 'main' && positionals.some((a) => a === 'HEAD' || a === '@')) return true;
  const safeFlag = flags.some((f) => ['--delete', '-d', '--tags', '--prune', '--mirror'].includes(f));
  const explicitTarget = positionals.length >= 2; // remote + refspec → not the current branch implicitly
  return branch === 'main' && !safeFlag && !explicitTarget;
}

// The branch a `switch`/`checkout -b` moves to, so a chain that creates the
// branch first isn't judged against the pre-switch branch. Plain
// `git checkout <x>` is intentionally not tracked (path-vs-branch ambiguous).
function switchTarget(sub, args) {
  if (sub !== 'switch' && sub !== 'checkout') return null;
  // `switch -` / `checkout -` jumps to the PREVIOUS branch, which the hook can't
  // resolve. Assume it could be main so a commit/push later in the SAME chain
  // stays guarded (else `git switch - && git commit` would sneak onto main).
  if (args.includes('-')) return 'main';
  if (sub === 'switch' || args.includes('-b') || args.includes('-B')) {
    const positionals = args.filter((a) => !a.startsWith('-'));
    return positionals[0] ?? null;
  }
  return null; // plain `git checkout <x>` — path-vs-branch ambiguous, not tracked
}

// Destructive git flags that no part of the ticket workflow needs, blocked on
// ANY branch. The broad `git …` allow-rules in .claude/settings.json are only
// safe because this hook rejects the dangerous shapes they would otherwise admit
// (force-push, force-add over .gitignore, force branch-delete, hard reset,
// untracked-file deletion, force checkout). Returns a reason or null.
export function destructiveGitReason(sub, args) {
  const has = (...flags) => args.some((a) => flags.includes(a));
  // A single-character short flag present anywhere in a single-dash cluster,
  // e.g. 'f' in `-uf` or 'd' in `-df` — so clustered flags can't slip past an
  // exact-token check. Excludes long (`--`) flags and `-o=val` attached values.
  const hasShort = (ch) =>
    args.some((a) => a.startsWith('-') && !a.startsWith('--') && !a.includes('=') && a.slice(1).includes(ch));
  switch (sub) {
    case 'push':
      // Force by flag (-f / -uf / --force / --force-with-lease) OR by the
      // `+refspec` force syntax (`git push origin +main`, `+feat/x`).
      if (has('--force') || hasShort('f') ||
          args.some((a) => a === '--force-with-lease' || a.startsWith('--force-with-lease=')) ||
          args.some((a) => a.startsWith('+')))
        return 'git push force (--force / -f / +refspec) rewrites remote history. Force-push is never part of the workflow — push normally and open a PR.';
      return null;
    case 'add':
    case 'stage':
      if (has('--force') || hasShort('f'))
        return 'git add -f overrides .gitignore and can stage ignored files (e.g. secrets / build artifacts). Stage only intended, non-ignored paths.';
      return null;
    case 'branch':
      // Force-delete = -D, or (--delete/-d) combined with (--force/-f), or a
      // single cluster carrying both (e.g. -Df / -df).
      if (hasShort('D') || ((has('--delete') || hasShort('d')) && (has('--force') || hasShort('f'))))
        return 'git branch force-delete (-D / --delete --force) discards unmerged commits. Use -d (safe delete) instead.';
      return null;
    case 'reset':
      if (has('--hard'))
        return 'git reset --hard irreversibly discards working-tree changes. Not part of the workflow.';
      return null;
    case 'clean':
      if (has('--force') || hasShort('f'))
        return 'git clean -f / --force permanently deletes untracked files. Not part of the workflow.';
      return null;
    case 'checkout':
      if (has('--force') || hasShort('f'))
        return 'git checkout -f discards local changes. Use git switch / git restore explicitly instead.';
      return null;
    default:
      return null;
  }
}

// Split a compound command into top-level segments on && || ; and newline —
// but NOT inside single/double quotes or $( … ) command substitutions. So data
// (a commit-message heredoc body, a quoted JS string that happens to contain
// `&&` or git verbs) is never mis-parsed as a separate command. Not a full shell
// parser — it covers the shapes the workflow actually produces; a stray
// unbalanced `)` inside a heredoc body is the known residual.
export function splitSegments(command) {
  const segments = [];
  let buf = '';
  let sq = false;   // inside '...'
  let dq = false;   // inside "..."
  let subst = 0;    // depth of $( … )
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (sq) { buf += c; if (c === "'") sq = false; continue; }
    if (c === "'" && !dq) { buf += c; sq = true; continue; }
    if (c === '"' && subst === 0) { buf += c; dq = !dq; continue; }
    if (c === '$' && next === '(') { buf += '$('; subst++; i++; continue; }
    if (subst > 0 && c === '(') { buf += c; subst++; continue; }
    if (subst > 0 && c === ')') { buf += c; subst--; continue; }
    if (!dq && subst === 0) {
      if (c === '&' && next === '&') { segments.push(buf); buf = ''; i++; continue; }
      if (c === '|' && next === '|') { segments.push(buf); buf = ''; i++; continue; }
      if (c === ';' || c === '\n') { segments.push(buf); buf = ''; continue; }
    }
    buf += c;
  }
  segments.push(buf);
  return segments.map((s) => s.trim()).filter(Boolean);
}

// `getBranch(dir)` is injected so the logic stays pure and testable. Branch state is
// keyed by directory: a chain can `cd` between repos, and a switch in one must not
// change what we believe another is on (tkt-74bc8f9b6ba5).
export function decide(command, getBranch, startDir) {
  if (typeof command !== 'string' || !command.trim()) return { blocked: false };

  // Quote/substitution-aware split so each git invocation is checked
  // independently without mis-splitting quoted data (see splitSegments). Single
  // `|` is intentionally not a split point.
  const segments = splitSegments(command);

  let dir = startDir ?? null;
  const outer = []; // dirs saved at `(` — a real shell restores cwd when the subshell exits
  const branches = new Map(); // dir -> effective branch; memoized, so one lookup per repo
  const branchFor = (d) => {
    if (!branches.has(d)) branches.set(d, getBranch(d));
    return branches.get(d);
  };

  for (const segment of segments) {
    for (let i = (segment.match(/^\(+/)?.[0].length) ?? 0; i > 0; i--) outer.push(dir);

    const moved = cdTarget(segment, dir);
    if (moved !== undefined) {
      dir = moved;
    } else {
      const git = parseGit(segment);
      if (git) {
        const { sub, args, repoDir } = git;
        const gitDir = repoDir ? resolveDir(dir, repoDir) : dir; // -C acts on that repo, whatever the cwd
        const verdict = ruleFor(sub, args, branchFor(gitDir));
        if (verdict) return { blocked: true, reason: verdict };
        const switched = switchTarget(sub, args);
        if (switched) branches.set(gitDir, switched);
      }
    }

    for (let i = (segment.match(/\)+$/)?.[0].length) ?? 0; i > 0 && outer.length; i--) dir = outer.pop();
  }

  return { blocked: false };
}

// `branch` is the branch of the repo THIS command acts on, not the hook's.
function ruleFor(sub, args, branch) {
  const destructive = destructiveGitReason(sub, args);
  if (destructive) return destructive;

  if ((sub === 'add' || sub === 'stage') && stagesEverything(args))
    return "git add/stage of the whole tree (-A / --all / . / *) stages everything. Stage only this ticket's files explicitly (git add <path> ...). See CLAUDE.md → Branch, commit & PR workflow.";

  if (sub === 'commit' && commitStagesAll(args))
    return "git commit -a / -am stages every tracked change, bypassing per-ticket staging. Stage this ticket's files explicitly, then commit without -a. See CLAUDE.md.";

  if (sub === 'commit' && branch === 'main')
    return 'Direct commits to main are not allowed — every ticket lands on its own branch via a squash-merged PR. Cut a <type>/<id>-<slug> branch first. See CLAUDE.md.';

  if (sub === 'push' && pushesMain(args, branch))
    return 'Direct pushes to main are not allowed — push your ticket branch and open a PR. See CLAUDE.md → Branch, commit & PR workflow.';

  // An unresolved branch is NOT a safe branch. Every failure that breaks `git rev-parse` — a bogus
  // GIT_CONFIG_PARAMETERS, GIT_CEILING_DIRECTORIES over the repo, a safe.directory refusal, git off
  // PATH — otherwise lands here as a SILENT allow, which is the sink that makes each of those a
  // main-commit bypass (tkt-fbc74a3252fe). Scoped to commit/push so an unresolvable branch still
  // can't wedge ordinary work, and last so explicit violations keep their precise message.
  if ((sub === 'commit' || sub === 'push') && branch === null)
    return 'Could not determine the current branch, so this commit/push cannot be checked against the never-commit-to-main rule. Refusing rather than guessing — check for a stale GIT_DIR/GIT_CONFIG_PARAMETERS in the environment, or a git safe.directory refusal, then retry. See CLAUDE.md → Branch, commit & PR workflow.';

  return null;
}

function branchIn(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(cwd ? { cwd } : {}),
    }).trim();
  } catch {
    return null;
  }
}

// An unusable dir falls back to `fallbackDir`, not null: a null branch never blocks,
// so without this `cd /typo; git commit` on main would slip through.
function currentBranch(dir, fallbackDir) {
  return (dir ? branchIn(dir) : null) ?? branchIn(fallbackDir);
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // not our concern if we can't parse the event
  }

  // payload.cwd is the project dir, not the Bash tool's cwd (verified 2026-07-15).
  const startDir = payload?.cwd ?? process.cwd();
  const getBranch = (dir) => currentBranch(dir, startDir);
  const { blocked, reason } = decide(payload?.tool_input?.command, getBranch, startDir);
  if (blocked) {
    process.stderr.write(`[guard-bash] Blocked: ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Run the I/O wiring only when invoked directly as the hook (not when imported
// by the test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
