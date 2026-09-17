#!/usr/bin/env node
// PreToolUse hook — once a session has called start_ticket, it may not write to any repository's
// PRIMARY checkout. Its work belongs in a linked worktree (tkt-1d647fd64ce4).
//
// WHY, measured: on 2026-09-16 three ticket sessions ran `checkout` in kanban's primary within
// seconds of each other. Each ticket did have a worktree, but it was created AFTER the branch was
// cut in the primary, so one ticket's edits sat in another's checkout and a single stash entry mixed
// two tickets' work. Isolation that depends on remembering to isolate is not isolation.
//
// TWO ENTRIES, and they are not interchangeable:
//   PreToolUse mcp__*__start_ticket → this file, which ARMS the session.
//   PreToolUse Edit|Write|NotebookEdit|Bash → guard-worktree-precheck.mjs, which enforces by
//   delegating HERE, but only after a marker file says this session is armed. That indirection is
//   deliberate: see that file's header.
//
// FAIL DIRECTION IS CLOSED, and the arming half is the reason. A marker that cannot be written
// blocks start_ticket rather than starting a ticket nobody is guarding, because a guard that
// silently does not apply is worse than no guard — it reports success.
//
// NO SessionEnd CLEANUP. Deleting the marker at exit would disarm a --resume'd mid-ticket session,
// whose cwd can be back in the primary. Measured on tkt-2ef9d53ea8b5: --resume and --continue keep
// the session_id, so the marker is still theirs. Each arm prunes markers older than 14 days instead.
//
// ONE DECOMPOSITION FOR THE BASH PATH. Directory moves and git invocations are found by the SAME
// walk over the same pieces. The first cut used two — segment-head only for git, mid-segment for
// `cd` — and they disagreed in both directions: `true | git checkout -- .` and `then git checkout`
// were never judged at all, and a truncated `cd /a/my repo` was caught at a segment head but not
// behind a pipe. Both were fail-opens found by review, and they are the same defect shell.mjs's own
// header warns about, one level up: two scanners desynchronise on exactly the edge cases the caller
// fails closed on.
//
// RESIDUALS — stated, never called containment:
//   - Non-git Bash writes. `sed -i`, `>`, heredocs and `npm install` are never judged, and a `cd`
//     into a primary checkout is itself not a verdict — so a RELATIVE write after one lands in the
//     primary too. (An earlier version of this header claimed the residual was limited to absolute
//     paths, on the grounds that a session in a worktree writes relatively. That is wrong whenever
//     the command cd's out first, and it under-reported the gap.)
//   - Command substitution: `VAR=$(cd /primary && git checkout -- .)` is not decomposed, the same
//     gap hooks/lib/shell.mjs documents for its own scanners (tkt-b9c0eda6c630).
//   - Deleting the marker, or a wrapper this file does not know — the same SCOPE statement as
//     guard-unattended-merge. Known wrappers (`env`, `sudo`, `xargs`, `time`, …) ARE followed.
//   - Sessions that never call start_ticket. There is nothing to arm on.
//   - A mid-ticket `/clear`: it mints a NEW session_id (measured, tkt-2ef9d53ea8b5), so the session
//     is no longer armed. ~/.claude/CLAUDE.md forbids clearing mid-ticket; nothing enforces it.
//   - A session rooted in a SUBDIRECTORY of a repo carrying its own project-scope .mcp.json can fail
//     to start the board server at all (measured: kanban, CONNECTION_CLOSED). With no working
//     start_ticket there is no arm, so the guard never applies there.
//   - Worktrees solve FILE collisions only. Concurrent dev servers still need a port offset.
// Subagents are NOT a residual: a subagent's PreToolUse carries the parent's session_id, so an armed
// parent arms its subagents (measured, tkt-2ef9d53ea8b5).

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { worktreeKind } from './lib/worktree.mjs';
import { protectedBranches, tryGit } from './lib/default-branch.mjs';
import { quotedTokens, resolveDir, SHELL_KEYWORDS, splitSegments, subshellParens } from './lib/shell.mjs';
import { parseGit } from './guard-bash.mjs';

const TAG = '[guard-worktree]';
const GUARDED_EDITS = new Set(['Edit', 'Write', 'NotebookEdit']);

// Matched by SUFFIX, not by an exact server name: this package is consumed by repos whose MCP server
// is not called `kanban`, and an exact match would leave those installs silently unarmed for the life
// of the install — no marker, no stderr, no signal at all. Same precedent as guard-ticket.mjs, which
// matches create_ticket this way "so the check survives a server rename".
const START_TICKET = /(?:^|__)start_ticket$/;

// Anchored, and deliberately narrower than "any string": the id becomes a FILENAME, so `..` and `/`
// would let a payload name a path outside the state dir.
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

export const MARKER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const ALLOW = { blocked: false };
const block = (reason) => ({ blocked: true, reason });

function stateDirOf(env) {
  return env?.WORKTREE_GUARD_STATE_DIR || join(homedir(), '.claude', 'state', 'worktree-guard');
}

export function markerPath(sessionId, env = process.env) {
  return join(stateDirOf(env), sessionId);
}

/**
 * 'armed' | 'unarmed' | 'unknown' — three answers, never two.
 *
 * existsSync would collapse "no marker" and "I am not allowed to look" into false, which is the
 * permissive answer reached by a probe that did not run. ENOENT is a real negative; anything else is
 * not an answer at all, and the caller fails closed on it.
 *
 * An id that does not match SESSION_ID reports 'unarmed', which is a DELIBERATE permissive edge and
 * not the same claim as the rest of this function: a malformed id cannot key a marker, but a payload
 * that simply omits session_id while the session IS armed lands here too, and this returns allow for
 * it. Wedging every tool call on the machine over a payload shape we cannot attribute is the worse
 * failure, so the trade is taken knowingly rather than argued away.
 */
export function armedState(sessionId, env = process.env) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return 'unarmed';
  try {
    statSync(markerPath(sessionId, env));
    return 'armed';
  } catch (e) {
    return e?.code === 'ENOENT' ? 'unarmed' : 'unknown';
  }
}

export function isArmed(sessionId, env = process.env) {
  return armedState(sessionId, env) === 'armed';
}

/** Housekeeping, never authorization — every failure here is swallowed on purpose. */
export function pruneMarkers(env = process.env, now = Date.now()) {
  let names;
  try {
    names = readdirSync(stateDirOf(env));
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(stateDirOf(env), name);
    try {
      if (now - statSync(p).mtimeMs > MARKER_MAX_AGE_MS) unlinkSync(p);
    } catch {
      // A concurrent session may have removed it, or it may be someone else's to remove.
    }
  }
}

export function arm(payload, env = process.env) {
  const id = payload?.session_id;
  if (typeof id !== 'string' || !SESSION_ID.test(id))
    return block(
      `${TAG} Blocked: start_ticket carried no usable session_id, so this session could not be armed.\n` +
        'Refusing to start a ticket the worktree guard cannot enforce.',
    );

  const ticket = typeof payload?.tool_input?.id === 'string' ? payload.tool_input.id : null;
  const lock = `${markerPath(id, env)}.lock`;
  let locked = false;
  try {
    mkdirSync(stateDirOf(env), { recursive: true });
    // Two start_ticket hooks in one session (parallel calls, a subagent) would otherwise read the same
    // prior marker and the last write would drop the other's ticket.
    locked = acquireLock(lock, lockWaitMs(env));
    const prior = priorMarker(id, env);
    const tickets = ticket && !prior.tickets.includes(ticket) ? [...prior.tickets, ticket] : prior.tickets;
    // A ticket this marker cannot name, or a write it could not serialise, can never vouch for every
    // ticket the session started, so the post-merge state becomes unreachable rather than skipped.
    const complete = locked && prior.complete && ticket !== null;
    writeFileSync(markerPath(id, env), JSON.stringify({ ticket, tickets, complete, armedAt: new Date().toISOString() }));
  } catch (e) {
    return block(
      `${TAG} Blocked: could not write the worktree-guard marker (${firstLine(e?.message)}).\n` +
        'Refusing to start a ticket that would then run unguarded.',
    );
  } finally {
    if (locked) releaseLock(lock);
  }
  // After the write, so the fresh marker's own mtime keeps it out of this sweep.
  pruneMarkers(env);
  return ALLOW;
}

/**
 * { ticket, tickets, complete } — `complete` is true only when `tickets` provably names EVERY ticket
 * this session started. A legacy single-ticket marker records only the last one, so it is incomplete.
 */
export function readMarker(sessionId, env = process.env) {
  let data;
  try {
    data = JSON.parse(readFileSync(markerPath(sessionId, env), 'utf8'));
  } catch {
    return { ticket: null, tickets: [], complete: false };
  }
  const ticket = typeof data?.ticket === 'string' ? data.ticket : null;
  if (!Array.isArray(data?.tickets)) return { ticket, tickets: ticket ? [ticket] : [], complete: false };
  if (!data.tickets.every((t) => typeof t === 'string')) return { ticket, tickets: [], complete: false };
  return { ticket, tickets: [...data.tickets], complete: data.complete === true };
}

const LOCK_WAIT_MS = 2_000;

function lockWaitMs(env) {
  const n = Number(env?.WORKTREE_GUARD_LOCK_WAIT_MS);
  return env?.WORKTREE_GUARD_LOCK_WAIT_MS !== undefined && Number.isFinite(n) && n >= 0 ? n : LOCK_WAIT_MS;
}

/** mkdir is atomic, so it is the lock. Any failure other than "held" reports unlocked, never locked. */
function acquireLock(lock, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      return true;
    } catch (e) {
      if (e?.code !== 'EEXIST' || Date.now() >= deadline) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function releaseLock(lock) {
  try {
    rmdirSync(lock);
  } catch {
    // A lock we cannot remove only makes later arms incomplete, which is the closed direction.
  }
}

function priorMarker(sessionId, env) {
  try {
    statSync(markerPath(sessionId, env));
  } catch (e) {
    return { tickets: [], complete: e?.code === 'ENOENT' };
  }
  return readMarker(sessionId, env);
}

export function decide(payload, opts = {}) {
  const { kindOf = worktreeKind, ticket = null, marker = null, mergeState = ghMergeState } = opts;
  const tool = payload?.tool_name;
  if (tool === 'Bash') return decideBash(payload, kindOf, ticket, { marker, mergeState });
  if (GUARDED_EDITS.has(tool)) return decideEdit(payload, kindOf, ticket);
  return ALLOW;
}

function decideEdit(payload, kindOf, ticket) {
  const input = payload?.tool_input;
  const target = input?.file_path ?? input?.notebook_path;
  if (typeof target !== 'string' || !target.trim())
    return block(`${TAG} Blocked: ${payload?.tool_name} carried no path, so the checkout it would write could not be judged.`);

  const dir = containingDir(target, payload?.cwd);
  if (dir === null)
    return block(`${TAG} Blocked: could not resolve ${target} to a directory, so its checkout is unknown.`);

  const kind = kindOf(dir);
  if (kind === 'linked' || kind === 'none') return ALLOW;
  return block(message(`a write to ${target}`, dir, kind, ticket, payload?.cwd));
}

/**
 * The nearest EXISTING ancestor of the target, realpathed, reduced to a directory.
 *
 * Nearest-existing because a file the tool is about to CREATE has no path of its own to resolve.
 * realpath because a symlink sitting in a worktree can point into the primary, and the lexical
 * reading of that path is the allow answer.
 */
function containingDir(target, cwd) {
  let p = isAbsolute(target) ? target : typeof cwd === 'string' && cwd ? resolve(cwd, target) : null;
  if (p === null) return null;
  for (let i = 0; i < 128; i++) {
    if (existsSync(p)) {
      try {
        const real = realpathSync(p);
        return statSync(real).isDirectory() ? real : dirname(real);
      } catch {
        return null;
      }
    }
    const parent = dirname(p);
    if (parent === p) return null;
    p = parent;
  }
  return null;
}

function decideBash(payload, kindOf, ticket, postMerge) {
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return ALLOW;

  const start = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : null;
  let dir = start;
  // Tracked separately from `dir`, never inferred from it: "moved somewhere I cannot name" and
  // "never moved" must not compare equal, because a null dir alone would fall through to the ALLOW
  // that "not a repo" earns.
  let unknownDir = start === null;
  const outer = [];
  const kinds = new Map();
  const kindFor = (d) => {
    if (!kinds.has(d)) kinds.set(d, kindOf(d));
    return kinds.get(d);
  };

  for (const segment of splitSegments(command)) {
    const parens = subshellParens(segment);
    for (let i = parens.open; i > 0; i--) outer.push([dir, unknownDir]);

    for (const piece of commandPieces(segment)) {
      const { envAssignments, tokens } = analysePiece(piece);
      const name = tokens[0];

      if (name === 'cd' || name === 'pushd' || name === 'popd') {
        // popd returns to a stack this does not track, so it reports unresolvable rather than
        // guessing — and unresolvable blocks the next mutating verb.
        const moved = name === 'popd' ? null : operandDir(tokens, dir);
        dir = moved;
        unknownDir = moved === null;
        continue;
      }

      const verdict = judgePiece(name, tokens, envAssignments, dir, unknownDir, kindFor, ticket, start, postMerge);
      if (verdict) return verdict;
    }

    for (let i = parens.close; i > 0 && outer.length; i--) [dir, unknownDir] = outer.pop();
  }
  return ALLOW;
}

/**
 * A segment's pipeline stages. splitSegments deliberately never breaks a pipeline — a `cd x | tee`
 * runs in a subshell — but each stage is still its own COMMAND, and a git invocation in a later
 * stage was invisible while only the segment head was read.
 */
function commandPieces(segment) {
  const out = [];
  let buf = '';
  let sq = false, dq = false, subst = 0;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (sq) { buf += c; if (c === "'") sq = false; continue; }
    if (c === "'" && !dq) { buf += c; sq = true; continue; }
    if (c === '"' && subst === 0) { buf += c; dq = !dq; continue; }
    if (c === '$' && segment[i + 1] === '(') { buf += '$('; subst++; i++; continue; }
    if (subst > 0) { buf += c; if (c === '(') subst++; else if (c === ')') subst--; continue; }
    if (!dq && c === '|') {
      if (segment[i + 1] === '|') { buf += '||'; i++; continue; } // a separator splitSegments owns
      out.push(buf); buf = ''; continue;
    }
    buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Shell words that precede a command without being one. Skipping them is what lets `then git …`,
// `do git …` and `xargs git …` reach the rules; leaving them in is the fail-open review found. The
// reserved words come from lib/shell.mjs so this hook and guard-bash's parseGit cannot drift on
// THAT set again — they already had, and parseGit was the one admitting `then git commit`
// (tkt-e70ae972476e). WRAPPERS below is still local, so the two do diverge on `then time git …`.
const WRAPPERS = new Set(['env', 'sudo', 'nice', 'nohup', 'xargs', 'command', 'builtin', 'exec', 'stdbuf', 'time']);

/**
 * The command a piece actually runs, plus any VAR=value prefixes.
 *
 * The env prefixes are RETURNED rather than merely skipped: GIT_DIR and GIT_WORK_TREE retarget git
 * at another checkout entirely, so dropping them silently is how a command gets judged against a
 * directory it never touches.
 */
function analysePiece(piece) {
  const raw = piece.trim().replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '');
  const tokens = quotedTokens(raw);
  const envAssignments = [];
  let i = 0;
  let sawWrapper = false;
  // Per token, not just at offset 0: the strip above runs once, so after a keyword is skipped a
  // following `(` survived and `then (git checkout -- .` read as a non-git piece (tkt-e70ae972476e).
  const bare = (t) => t.replace(/^[({]+/, '');
  while (i < tokens.length) {
    const t = bare(tokens[i]);
    if (t === '') { i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { envAssignments.push(t); i++; continue; }
    if (SHELL_KEYWORDS.has(t)) { i++; continue; }
    if (WRAPPERS.has(t)) { sawWrapper = true; i++; continue; }
    // Only after a wrapper: `grep -n git file` must NOT have its flags skipped down to `git`.
    if (sawWrapper && t.startsWith('-')) { i++; continue; }
    break;
  }
  const rest = tokens.slice(i);
  return { envAssignments, tokens: rest.length ? [bare(rest[0]), ...rest.slice(1)] : rest };
}

/** The directory operand of a cd/pushd, or null when it names something this cannot resolve. */
function operandDir(tokens, dir) {
  const args = tokens.slice(1);
  const redirect = args.findIndex((a) => /^[0-9]*[<>]/.test(a));
  const operands = redirect === -1 ? args : args.slice(0, redirect);
  let i = 0;
  while (i < operands.length && operands[i] !== '-' && operands[i].startsWith('-')) {
    const doubleDash = operands[i] === '--';
    i++;
    if (doubleDash) break;
  }
  // `cd /a/my dir` — the shell word-splits, so the operand is only `/a/my` and the directory the
  // human meant is NOT the one that resolves. guard-bash tolerates this because its wrong answer
  // merely picks a repo; here the wrong answer is very likely a path outside any repo, which is
  // ALLOW. Applied to EVERY cd, not only a segment-initial one — the first cut checked it at the
  // head and not behind a pipe, which review measured as a live bypass.
  if (operands.length - i > 1) return null;
  const target = operands[i];
  if (!target || target === '-') return null;
  return resolveDir(dir, target);
}

function judgePiece(name, tokens, envAssignments, dir, unknownDir, kindFor, ticket, start, postMerge) {
  if (name === 'git') {
    const git = parseGit(tokens.join(' '));
    if (!git) return null;
    const { sub, args, repoDir, truncated } = git;
    if (truncated) return block(unresolvable('a git command whose quoting is unterminated', ticket));

    // Judged BEFORE the directory, and it is one of two rules that are: refs/stash lives in the
    // common dir, so a pop from a linked worktree of its own still takes work off the shared stack.
    // That is the mixed stash@{0} this guard was written for.
    if (sub === 'stash' && stashMutates(args))
      return block(
        `${TAG} Blocked: git stash writes refs/stash, which lives in the repository's COMMON directory.\n` +
          "A stash push or pop is therefore shared with every other worktree and can take another session's work.\n" +
          'Commit to your branch instead. `git stash list` and `git stash show` are allowed.',
      );

    const readOnly = readOnlyFromPrimary(sub, args);

    // The other directory-independent rule. These name a checkout the rest of this function cannot
    // see, so the judged `dir` would describe a command that acts somewhere else entirely.
    if (!readOnly && retargeted(tokens, envAssignments))
      return block(
        `${TAG} Blocked: this command retargets git with --git-dir/--work-tree or GIT_DIR/GIT_WORK_TREE,\n` +
          'so which checkout it writes cannot be read from the command line it runs on.\n' +
          'Run it from inside the worktree you mean, without the override.',
      );

    // push and fetch are read-only ABOUT A REMOTE. Pointed at a local path they are neither:
    // `git push . HEAD:refs/heads/x` can update a checked-out branch (with
    // receive.denyCurrentBranch=updateInstead it rewrites that worktree's files), and
    // `git fetch . main:x` moves any local branch that is not currently checked out.
    if ((sub === 'push' || sub === 'fetch') && namesLocalRepo(args))
      return block(
        `${TAG} Blocked: git ${sub} against a LOCAL path can move branches, and can rewrite a\n` +
          'checked-out worktree outright under receive.denyCurrentBranch=updateInstead.\n' +
          'Push or fetch against a named remote instead.',
      );

    if (readOnly) return null;

    const target = repoDir ? resolveDir(dir, repoDir) : dir;
    const unknown = repoDir ? target === null : unknownDir || dir === null;
    if (unknown || target === null) return block(unresolvable(`git ${sub ?? ''}`.trim(), ticket));
    const denied = judgeDir(target, kindFor, ticket, start, `git ${sub}`);
    if (!denied || kindFor(target) !== 'primary') return denied;
    const cleanup = postMergeCleanup(sub, args, target, postMerge);
    if (cleanup === null) return denied;
    return cleanup.ok ? null : block(`${denied.reason}\nPost-merge cleanup refused: ${cleanup.why}.`);
  }

  if (name === 'gh' && ghMutates(tokens)) {
    if (unknownDir || dir === null) return block(unresolvable('gh pr checkout', ticket));
    return judgeDir(dir, kindFor, ticket, start, 'gh pr checkout');
  }
  return null;
}

function judgeDir(target, kindFor, ticket, start, what) {
  const kind = kindFor(target);
  if (kind === 'linked' || kind === 'none') return null;
  return block(message(what, target, kind, ticket, start));
}

const READ_ONLY = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'fetch', 'push', 'remote', 'ls-files', 'ls-remote',
  'blame', 'grep', 'merge-base', 'rev-list', 'check-ignore', 'describe',
]);
const STASH_READS = new Set(['list', 'show']);
const BRANCH_MUTATORS = new Set([
  '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force',
  '-u', '--set-upstream-to', '--unset-upstream', '--edit-description',
]);
// Read-only selectors that take a VALUE. Without these, their operand reads as a name to create, and
// `git branch --contains HEAD` — an ordinary thing to run while inspecting — is refused.
const SELECTORS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--color']);

/**
 * Verbs a primary checkout may still run. An ALLOWLIST, so a verb git adds tomorrow — or one nobody
 * thought of — lands in the block branch rather than walking through unrecognised.
 */
function readOnlyFromPrimary(sub, args) {
  if (READ_ONLY.has(sub)) return true;
  if (sub === 'stash') return !stashMutates(args);
  if (sub === 'branch' || sub === 'tag') return listForm(args);
  if (sub === 'config') return args.some((a) => a === '--list' || a === '-l' || a.startsWith('--get'));
  if (sub === 'worktree') return worktreeAllowed(args);
  return false;
}

const positional = (args) => args.find((a) => !a.startsWith('-'));

/**
 * `git branch` and `git tag` both read and write depending only on their arguments. A bare
 * positional NAMES something to create — unless it is the value of a read-only selector, or the
 * pattern of an explicit --list.
 */
function listForm(args) {
  if (args.some((a) => BRANCH_MUTATORS.has(a))) return false;
  if (args.includes('--list') || args.includes('-l')) return true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (SELECTORS.has(a)) { i++; continue; } // consumes its value
    if (a.startsWith('-')) continue;         // includes --selector=value
    return false;                            // an unconsumed positional
  }
  return true;
}

// A bare `git stash` IS a push, which is why the absent-subcommand case mutates.
function stashMutates(args) {
  const sub = positional(args);
  return !sub || !STASH_READS.has(sub);
}

function worktreeAllowed(args) {
  const sub = positional(args);
  if (sub === 'add' || sub === 'list' || sub === 'prune') return true;
  // A non-forced remove is safe because EnterWorktree locks its worktrees and git refuses to remove
  // a locked or dirty one. `-f` is exactly the flag that overrides that refusal.
  if (sub === 'remove') return !args.some((a) => a === '-f' || a === '--force');
  return false;
}

function retargeted(tokens, envAssignments) {
  return (
    tokens.some((t) => /^--(git-dir|work-tree)(=|$)/.test(t)) ||
    envAssignments.some((t) => /^GIT_(DIR|WORK_TREE)=/.test(t))
  );
}

// A remote NAME has no path shape. `.`, `..`, `/abs` and `./rel` all name a local repository.
function namesLocalRepo(args) {
  const repo = positional(args);
  return typeof repo === 'string' && /^(\.{1,2}$|\.{0,2}\/)/.test(repo);
}

// Deliberately narrow: `gh pr checkout` is the one gh command that rewrites a working tree. The rest
// is API traffic, which a primary checkout is welcome to do.
function ghMutates(tokens) {
  const words = tokens.slice(1).filter((t) => !t.startsWith('-'));
  return words[0] === 'pr' && words[1] === 'checkout';
}

// ── Post-merge state (tkt-c9ae67a61caf) ─────────────────────────────────────────────────────────
// Not a disarm. `status: done` is never consulted: the session sets it itself, so trusting it would
// let a session unlock itself. Only a PR that gh reports merged unlocks, and only these two shapes.

/** The cleanup a command is shaped as — null when it is not one, so the ordinary block stands. */
function cleanupShape(sub, args) {
  if (sub === 'pull' || sub === 'merge') {
    if (args.filter((a) => a === '--ff-only').length !== 1) return null;
    return { kind: 'ff', sub, operands: args.filter((a) => a !== '--ff-only') };
  }
  if (sub === 'checkout') return args[0] === '--' ? { kind: 'restore', paths: args.slice(1) } : null;
  if (sub === 'restore') {
    const paths = args[0] === '--' ? args.slice(1) : args;
    return paths.some((a) => a.startsWith('-')) ? null : { kind: 'restore', paths };
  }
  return null;
}

/** null: not a cleanup shape. { ok: true }: allow. { ok: false, why }: still blocked, with the reason. */
function postMergeCleanup(sub, args, dir, postMerge) {
  const shape = cleanupShape(sub, args);
  if (!shape) return null;
  const refuse = (why) => ({ ok: false, why });

  const root = tryGit(['rev-parse', '--show-toplevel'], dir).out;
  if (!root) return refuse('the repository root could not be resolved');
  const branches = protectedBranches(root);
  if (!branches || branches.length !== 1) return refuse('the default branch could not be determined');
  const base = branches[0];
  const upstream = `origin/${base}`;
  if (!tryGit(['rev-parse', '--verify', '--quiet', `${upstream}^{commit}`], root).out)
    return refuse(`${upstream} does not exist`);
  // Any other branch in a primary is a paused session's work, not this ticket's leftovers.
  if (tryGit(['symbolic-ref', '--short', 'HEAD'], root).out !== base) return refuse(`the primary is not on ${base}`);

  const local = shape.kind === 'ff' ? fastForwardProblem(shape, base, upstream, root) : restoreProblem(shape.paths, dir, upstream);
  if (local) return refuse(local);

  // Local checks first: they are cheap and offline, and the verifier below is a network call.
  return everyTicketMerged(postMerge, root, base)
    ? { ok: true }
    : refuse(`not every ticket this session started has a PR verified merged into ${base} in ${root}`);
}

function everyTicketMerged(postMerge, root, base) {
  const marker = postMerge?.marker;
  if (!marker?.complete || !Array.isArray(marker.tickets) || marker.tickets.length === 0) return false;
  return marker.tickets.every((t) => {
    try {
      return postMerge.mergeState(t, root, base) === 'merged';
    } catch {
      return false;
    }
  });
}

function fastForwardProblem({ sub, operands }, base, upstream, root) {
  // Explicit operands only: a bare `git pull` follows branch.<base>.remote/merge, which can name
  // any branch at all.
  const allowed = sub === 'pull' ? ['origin', base] : [upstream];
  if (operands.length !== allowed.length || operands.some((x, i) => x !== allowed[i]))
    return `only \`git pull --ff-only origin ${base}\` or \`git merge --ff-only ${upstream}\` is allowed`;
  const status = tryGit(['status', '--porcelain', '--untracked-files=no'], root);
  if (status.err !== undefined) return 'the working tree state could not be read';
  if (status.out) return 'the primary has tracked modifications';
  if (tryGit(['merge-base', '--is-ancestor', 'HEAD', upstream], root).err !== undefined)
    return `${base} is not an ancestor of ${upstream}, so this is not a pure fast-forward`;

  // git refuses to overwrite an untracked file, but overwrites an IGNORED one silently — so any
  // stray path the fast-forward would write is refused here, ignored or not.
  const incoming = tryGit(['diff', '-z', '--name-only', '--no-renames', 'HEAD', upstream], root);
  const stray = tryGit(['status', '-z', '--porcelain', '--ignored', '--untracked-files=normal'], root);
  if (incoming.err !== undefined || stray.err !== undefined) return 'the paths this would write could not be listed';
  const names = incoming.out.split('\0').filter(Boolean);
  const clash = stray.out
    .split('\0')
    .filter((e) => e.startsWith('?? ') || e.startsWith('!! '))
    .map((e) => e.slice(3).replace(/\/$/, ''))
    .find((p) => names.some((n) => n === p || n.startsWith(`${p}/`) || p.startsWith(`${n}/`)));
  return clash ? `${clash} is untracked or ignored here and ${upstream} would overwrite it` : null;
}

function restoreProblem(paths, dir, upstream) {
  if (paths.length === 0) return 'no path was named';
  for (const p of paths) {
    if (!p || /[*?[\]]/.test(p) || p.startsWith(':') || p.startsWith('-')) return `${p} is not a literal file path`;
    let stat;
    try {
      stat = lstatSync(resolve(dir, p));
    } catch {
      return `${p} does not exist`;
    }
    // A symlink's blob is its target PATH, while hash-object follows it to the content.
    if (!stat.isFile()) return `${p} is not a regular file`;
    const listed = tryGit(['--literal-pathspecs', 'ls-files', '--full-name', '--error-unmatch', '--', p], dir);
    if (listed.err !== undefined || !listed.out || listed.out.includes('\n')) return `${p} is not a tracked file`;
    const want = tryGit(['rev-parse', '--verify', '--quiet', `${upstream}:${listed.out}`], dir).out;
    // --no-filters: a clean filter or eol conversion can hash a locally edited file equal to the blob.
    const have = tryGit(['--literal-pathspecs', 'hash-object', '--no-filters', p], dir).out;
    if (!want || !have || want !== have) return `${p} differs from ${upstream}, so restoring it would discard work`;
  }
  return null;
}

const GH_TIMEOUT_MS = 10_000;

/** HOST/OWNER/REPO from a GitHub-shaped remote URL, or null for anything else (a local path included). */
function githubRepo(url) {
  const m = typeof url === 'string'
    ? url.match(/^(?:(?:https?|ssh):\/\/(?:[^@/]+@)?|[^@/:]+@)([A-Za-z0-9.-]+)(?::\d+)?[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/)
    : null;
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

/**
 * 'merged' | 'unmerged' | 'unknown' for one ticket. The repo is pinned with -R from `origin`'s URL
 * and GH_REPO is stripped: gh's own resolution follows GH_REPO and `gh repo set-default`, either of
 * which can answer for a different repository. Only 'merged' unlocks, and an OPEN PR naming the
 * ticket vetoes an earlier merged one. Residual: only the 100 most recent PRs are read.
 */
export function ghMergeState(ticket, root, base, run = spawnSync, git = tryGit) {
  const repo = githubRepo(git(['remote', 'get-url', 'origin'], root).out);
  if (!repo) return 'unknown';
  const env = { ...process.env, GH_PROMPT_DISABLED: '1' };
  delete env.GH_REPO;
  let r;
  try {
    r = run('gh', ['pr', 'list', '-R', repo, '--state', 'all', '--limit', '100', '--json', 'headRefName,baseRefName,mergedAt,state'], {
      cwd: root,
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch {
    return 'unknown';
  }
  if (!r || r.error || r.signal || r.status !== 0) return 'unknown';
  let prs;
  try {
    prs = JSON.parse(r.stdout);
  } catch {
    return 'unknown';
  }
  if (!Array.isArray(prs)) return 'unknown';
  const escaped = String(ticket).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`);
  const mine = prs.filter((pr) => typeof pr?.headRefName === 'string' && names.test(pr.headRefName));
  if (mine.some((pr) => pr.state !== 'MERGED' && pr.state !== 'CLOSED')) return 'unmerged';
  const merged = mine.some(
    (pr) => pr.state === 'MERGED' && pr.baseRefName === base && typeof pr.mergedAt === 'string' && pr.mergedAt !== '',
  );
  return merged ? 'merged' : 'unmerged';
}

function message(what, dir, kind, ticket, sessionCwd) {
  // The REPO ROOT, not the directory that happened to contain the file: naming `<repo>/src` as "the
  // primary checkout" is wrong, and the worktree-exists check below would look for
  // `<repo>/src/.claude/worktrees/<id>` and never find it.
  const root = repoRoot(dir);
  const where =
    kind === 'primary'
      ? `the PRIMARY checkout ${root}`
      : `${dir}, whose checkout kind git could not determine`;
  const lines = [`${TAG} Blocked: ${what} in ${where}.`];
  if (ticket) lines.push(`This session started ${ticket}, so its work belongs in a linked worktree.`);
  lines.push(fix(root, ticket, sessionCwd));
  return lines.join('\n');
}

function unresolvable(what, ticket) {
  return (
    `${TAG} Blocked: could not determine which checkout ${what} would act on.\n` +
    'A directory this guard cannot name is refused rather than guessed at (an unnameable target is ' +
    'the one shape that would otherwise pass as "not a repo").\n' +
    `Name the directory literally${ticket ? `, from inside ${ticket}'s worktree` : ''}.`
  );
}

function fix(root, ticket, sessionCwd) {
  const id = ticket ?? '<ticket-id>';
  // Compared by COMMON dir, not by toplevel: a primary and its worktrees share one common dir, so
  // this asks "is it the same repository", not "is it the same directory".
  const here = repoIdentity(sessionCwd);
  const there = repoIdentity(root);
  if (!here || !there || here !== there)
    return `Fix: cd ${root} && git worktree add --detach .claude/worktrees/${id} <base>`;

  const existing = join(root, '.claude', 'worktrees', id);
  return existsSync(existing)
    ? `Fix: EnterWorktree({ path: ".claude/worktrees/${id}" })  — it already exists at ${existing}`
    : `Fix: EnterWorktree({ name: "${id}" })`;
}

function repoRoot(dir) {
  const r = tryGit(['rev-parse', '--show-toplevel'], dir);
  return r.err || !r.out ? dir : r.out;
}

function repoIdentity(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  const r = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir);
  if (r.err || !r.out) return null;
  try {
    return realpathSync(r.out);
  } catch {
    return r.out;
  }
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].slice(0, 200);
}

function fail(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/**
 * The enforcing entry point, taking the payload bytes the caller has ALREADY read.
 *
 * stdin is read-once: the precheck must consume it to learn whether this session is armed, so it
 * cannot hand this module a fresh fd 0. Passing the bytes is the only spelling that works.
 */
export function run(raw, env = process.env) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail(`${TAG} Blocked: the hook payload could not be parsed, so this call could not be judged.`);
  }

  if (typeof payload?.tool_name === 'string' && START_TICKET.test(payload.tool_name)) {
    const armed = arm(payload, env);
    if (armed.blocked) fail(armed.reason);
    process.exit(0);
  }

  const state = armedState(payload?.session_id, env);
  if (state === 'unknown')
    fail(`${TAG} Blocked: the worktree-guard state could not be read, so this session's arming is unknown.`);
  if (state === 'unarmed') process.exit(0);

  const marker = readMarker(payload.session_id, env);
  const verdict = decide(payload, { ticket: marker.ticket, marker });
  if (verdict.blocked) fail(verdict.reason);
  process.exit(0);
}

export function main() {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    fail(`${TAG} Blocked: the hook payload could not be read, so this call could not be judged.`);
  }
  run(raw);
}

if (isMain(import.meta.url)) main();
