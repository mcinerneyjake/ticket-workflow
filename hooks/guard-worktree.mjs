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
//   - Non-git writers off the denylist: `npm run`/`exec`, `node -e`, `dd of=`, `find -delete`,
//     `curl -o`, `rsync`, an interpreter's own I/O. Listed writers are judged where they land.
//   - Shapes the write rules misread: `>(…)` process substitution, brace expansion, `for ((…))`
//     and `[[ … && a > b ]]`, and relative or `$VAR` words feeding xargs (tkt-019899cb717a).
//   - Anything under a primary's `.git/`, which worktreeKind reads as 'none' (tkt-b181fcaed28a).
//   - A bare `&` leaves the next command inside the previous piece, unjudged (tkt-1949a886e811).
//   - Backslash-escaped quotes, which quotedTokens reads as opening a quote (tkt-5ad1c320bc0a).
//   - Value-taking wrappers (`sudo -u x`, `nice -n 5`) and `timeout` (tkt-cc86e71e6454).
//   - A `cd` behind a pipe is read as a real move of this shell (tkt-72f1ad204ea6).
//   - Heredoc bodies are judged line by line, as git always was: `=>` or `a > b` in one false-blocks
//     from a primary cwd, and an apostrophe in one desyncs quoting after it (tkt-cee27aa7d421).
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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { worktreeKind } from './lib/worktree.mjs';
import { protectedBranches, tryGit } from './lib/default-branch.mjs';
import { dequote, quotedTokens, resolveDir, SHELL_KEYWORDS, splitSegments, subshellParens, WRAPPERS } from './lib/shell.mjs';
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
  const { kindOf = worktreeKind, ticket = null, marker = null, mergeState = ghMergeState, env = process.env } = opts;
  const tool = payload?.tool_name;
  if (tool === 'Bash') return decideBash(payload, kindOf, ticket, { marker, mergeState }, env);
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

/** Where a write through a dangling link creates its file, resolved from the link's REAL directory. */
function danglingLinkTarget(p) {
  try {
    if (!lstatSync(p).isSymbolicLink() || existsSync(p)) return null;
    return resolve(realpathSync(dirname(p)), readlinkSync(p));
  } catch {
    return null;
  }
}

function decideBash(payload, kindOf, ticket, postMerge, env) {
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

    // Words of earlier pipeline stages: what an operand-less `xargs rm` is fed from.
    const upstream = [];
    for (const piece of commandPieces(segment)) {
      const { words, targets } = splitRedirects(quotedTokens(piece));
      const { envAssignments, tokens } = analysePiece(words.join(' '));
      const name = tokens[0];
      const judge = writeJudge(dir, unknownDir, kindFor, ticket, start, command, env);

      // Before any move: a cd's own redirect opens in the directory it leaves.
      for (const target of targets) {
        const denied = judge.path(target, `a redirect to ${target}`);
        if (denied) return denied;
      }

      if (name === 'cd' || name === 'pushd' || name === 'popd') {
        // popd returns to a stack this does not track, so it reports unresolvable rather than
        // guessing — and unresolvable blocks the next mutating verb.
        const moved = name === 'popd' ? null : operandDir(tokens, dir);
        dir = moved;
        unknownDir = moved === null;
        upstream.push(...words);
        continue;
      }

      const verdict =
        judgeWriter(tokens, words.includes('xargs'), upstream, judge) ??
        judgePiece(name, tokens, envAssignments, dir, unknownDir, kindFor, ticket, start, postMerge);
      if (verdict) return verdict;
      upstream.push(...words);
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
      if (segment[i + 1] === '&') { out.push(buf); buf = ''; i++; continue; } // `|&` pipes stderr too
      // `>|` clobbers, and splitting it hides the target. An escaped `\>` is a literal, so that `|`
      // is a real pipe, and fusing it would hide the command after it.
      if (buf.endsWith('>') && !buf.endsWith('\\>')) { buf += c; continue; }
      out.push(buf); buf = ''; continue;
    }
    buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

// SHELL_KEYWORDS and WRAPPERS come from lib/shell.mjs, shared with guard-bash's parseGit, which had
// drifted on both (tkt-e70ae972476e, tkt-3d016709216a). The skip LOOP below is still a second copy
// of parseGit's, so a rule added to one is not in the other.

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
  const operands = tokens.slice(1);
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

// Non-git writes, judged by WHERE THEY LAND (tkt-12cbf1b396aa). A DENYLIST on purpose: an allowlist
// of readers false-blocks the probes the docs prescribe running in a primary.
const OPERAND_WRITERS = new Set(['rm', 'rmdir', 'unlink', 'touch', 'mkdir', 'truncate', 'shred', 'mv', 'chmod', 'chown', 'chgrp']);
// These act on a symlink itself, never on what it points at.
const ON_THE_LINK = new Set(['rm', 'rmdir', 'unlink']);
const MODE_FIRST = new Set(['chmod', 'chown', 'chgrp']);
const DEST_WRITERS = new Set(['cp', 'ln', 'install']);
// Only argument-free switches may precede the `i`: in perl's `-Ilib` the i is an argument.
const IN_PLACE = { sed: /^-[nrsuzE]*[iI]/, perl: /^-[0-9nplaswTtWX]*i/ };
const SCRIPT_FLAGS = new Set(['-e', '-E', '-f', '--expression', '--file']);
// Flags whose next word is a value, which read as an operand would resolve to a bogus path.
const VALUE_FLAGS = {
  truncate: ['-s', '--size', '-r', '--reference'],
  touch: ['-d', '-t', '-r', '--date', '--reference'],
  mkdir: ['-m', '--mode'],
  install: ['-m', '--mode', '-o', '--owner', '-g', '--group', '-t', '--target-directory'],
  cp: ['-t', '--target-directory'],
  ln: ['-t', '--target-directory'],
  sed: ['-e', '--expression', '-f', '--file', '-l'],
  perl: ['-e', '-E', '-M', '-m', '-I', '-x'],
  chmod: ['--reference'],
  chown: ['--reference'],
  chgrp: ['--reference'],
};
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_WRITES = new Set([
  'install', 'i', 'in', 'ci', 'it', 'cit', 'install-test', 'install-ci-test', 'add', 'remove', 'rm', 'r',
  'uninstall', 'un', 'update', 'up', 'upgrade', 'link', 'dedupe', 'prune', 'rebuild', 'init',
]);
const PACKAGE_DIR_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd']);
const PACKAGE_VALUE_FLAGS = new Set([...PACKAGE_DIR_FLAGS, '--loglevel', '--filter', '-F', '--workspace', '--registry', '--tag', '--cache', '--userconfig', '--reporter']);
const YARN_QUERIES = new Set(['--version', '-v', '--help', '-h']);
const SCRIPT_RUNS = new Set(['run', 'run-script', 'rum', 'urn', 'test', 't', 'tst', 'start', 'stop', 'restart', 'exec', 'x']);

function writeJudge(dir, unknownDir, kindFor, ticket, start, command, env) {
  const here = (what) =>
    unknownDir || dir === null ? block(unresolvable(what, ticket)) : judgeDir(dir, kindFor, ticket, start, what);
  const landing = (resolved, what, follow) => {
    // A write through a dangling link creates its target, yet a tool may replace the link instead,
    // so both places are judged.
    const through = follow ? danglingLinkTarget(resolved) : null;
    for (const p of through === null ? [resolved] : [resolved, through]) {
      const at = follow ? containingDir(p, dir) : linkLanding(p, dir);
      const denied = at === null ? block(unresolvable(what, ticket)) : judgeDir(at, kindFor, ticket, start, what);
      if (denied) return denied;
    }
    return null;
  };
  const path = (word, what, follow = true) => {
    let literal = dequote(word);
    if (literal === null) return block(unresolvable(what, ticket));
    const expanded = expandKnownVar(literal, command, env);
    if (expanded !== literal) word = literal = expanded;
    const resolved = resolveDir(dir, word);
    // `rm -r link/` acts through the link; path.resolve drops the slash that says so.
    if (resolved !== null) return landing(resolved, what, follow || literal.endsWith('/'));
    // A `$VAR` or glob leaf still sits in whatever directory its literal prefix names.
    const cut = literal.search(/[$*?[{]/);
    const prefix = cut === -1 ? '' : literal.slice(0, literal.lastIndexOf('/', cut) + 1);
    if (!prefix) return here(what);
    const base = resolveDir(dir, prefix);
    return base === null ? block(unresolvable(what, ticket)) : landing(base, what, true);
  };
  return { here, path };
}

const KNOWN_VARS = ['HOME', 'TMPDIR'];

/** `$TMPDIR/x` → the hook's own TMPDIR, unless this command assigns or reads into that variable. */
function expandKnownVar(literal, command, env) {
  for (const v of KNOWN_VARS) {
    const m = literal.match(new RegExp(`^(?:\\$${v}|\\$\\{${v}\\})(?=/|$)`));
    const value = env?.[v];
    if (!m || typeof value !== 'string' || !isAbsolute(value)) continue;
    const set = new RegExp(`(?:^|[^A-Za-z0-9_])${v}=|\\b(?:export|read|declare|local|typeset|unset|for)\\b[^;&|\\n]*\\b${v}\\b`);
    if (set.test(command)) continue;
    return value + literal.slice(m[0].length);
  }
  return literal;
}

/** A symlink is judged where it sits; anything else where it resolves. */
function linkLanding(p, cwd) {
  try {
    if (lstatSync(p).isSymbolicLink()) return containingDir(dirname(p), cwd);
  } catch {
    // Absent: nothing to follow, so the walk below finds its nearest existing ancestor.
  }
  return containingDir(p, cwd);
}

function judgeWriter(tokens, fedByXargs, upstream, judge) {
  const name = commandName(tokens[0]);
  const written = writtenPaths(name, tokens.slice(1));
  if (written === null) return null;
  if (written.length === 0 || fedByXargs) {
    // Targets arriving on stdin (`find /primary | xargs rm`, `xargs -I{} rm {}`) land where the
    // absolute paths of the earlier stages say.
    if (!PACKAGE_MANAGERS.has(name)) {
      for (const w of upstream) {
        const literal = dequote(w);
        if (literal === null || !/^[/~]/.test(literal)) continue;
        const denied = judge.path(w, `${name} fed from ${w}`);
        if (denied) return denied;
      }
    }
    if (written.length === 0) return judge.here(name);
  }
  for (const [p, follow] of written) {
    const denied = judge.path(p, `${name} ${p}`, follow);
    if (denied) return denied;
  }
  return null;
}

/** `/bin/rm`, `\rm` and `"rm"` all run rm. */
function commandName(token) {
  const d = dequote(token ?? '');
  return d === null ? '' : basename(d.replace(/^\\/, ''));
}

const REDIRECT_OP = /^(?:<>|&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<)/;
const WRITE_OPS = new Set(['<>', '&>>', '&>', '>>', '>|', '>&', '>']);

/**
 * A piece's redirect targets and its remaining words. Arithmetic compares; `>&2` duplicates a
 * descriptor. unquotedIndex honours backslashes and quotedTokens does not (tkt-5ad1c320bc0a).
 */
function splitRedirects(tokens) {
  const words = [];
  const targets = [];
  let skip = null;
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    let t = raw;
    const atCommand = i === 0 || SHELL_KEYWORDS.has(tokens[i - 1]);
    if (!skip && atCommand && (raw === '[[' || raw.startsWith('(('))) {
      skip = raw === '[[' ? ']]' : '))';
      t = raw.slice(2);
    }
    if (skip) {
      const end = t.indexOf(skip);
      if (end === -1) { words.push(raw); continue; }
      t = t.slice(end + skip.length);
      skip = null;
    }
    for (let open = unquotedIndex(t, '$(('); open !== -1; open = unquotedIndex(t, '$((')) {
      const end = t.indexOf('))', open + 3);
      if (end === -1) { skip = '))'; t = t.slice(0, open); break; }
      t = t.slice(0, open) + t.slice(end + 2);
    }

    let at = unquotedIndex(t, '<', '>');
    if (at === -1) { words.push(raw); continue; }
    if (t[at] === '>' && at > 0 && t[at - 1] === '&') at--;
    const lead = t.slice(0, at);
    if (lead && !/^[0-9]+$/.test(lead)) words.push(lead);
    t = t.slice(at);
    // A token can fuse several: `2>/dev/null>out`, `<in>out`.
    while (t !== '') {
      const [op] = t.match(REDIRECT_OP) ?? [''];
      t = t.slice(op.length);
      let word;
      if (t === '') {
        word = tokens[++i] ?? '';
      } else {
        const next = unquotedIndex(t, '<', '>');
        const cut = next > 0 && t[next] === '>' && t[next - 1] === '&' ? next - 1 : next;
        word = cut === -1 ? t : t.slice(0, cut).replace(/[0-9]+$/, '');
        t = cut === -1 ? '' : t.slice(cut);
      }
      if (!WRITE_OPS.has(op)) continue;
      if (op === '>&' && /^(?:[0-9]+-?|-)$/.test(word)) continue;
      word = word.replace(/\)+$/, '');
      if (word === '' || word.startsWith('(')) continue;
      targets.push(word);
    }
  }
  return { words, targets };
}

/** Index of the first unquoted occurrence of any needle, honouring backslash escapes. */
function unquotedIndex(token, ...needles) {
  let quote = null;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (needles.some((n) => token.startsWith(n, i))) return i;
  }
  return -1;
}

/**
 * [path, followLink] pairs a recognised writer writes; [] means "the directory itself", null means
 * not a writer.
 */
function writtenPaths(name, args) {
  const valueFlags = new Set(VALUE_FLAGS[name] ?? []);
  const operands = [];
  let target = null;
  let scriptGiven = false;
  let inPlace = false;
  let flagsDone = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flagsDone || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
    if (a === '--') { flagsDone = true; continue; }
    if (a.startsWith('--target-directory=')) { target = a.slice('--target-directory='.length); continue; }
    if (name === 'chmod' && /^-[rwxXst]+$/.test(a)) { operands.push(a); continue; }
    if (valueFlags.has(a)) {
      if (SCRIPT_FLAGS.has(a)) scriptGiven = true;
      const value = args[++i];
      if (a === '-t' || a === '--target-directory') target = value ?? null;
      continue;
    }
    if (name in IN_PLACE && (IN_PLACE[name].test(a) || a.startsWith('--in-place'))) {
      inPlace = true;
      // BSD's `-i ''` takes its (empty) suffix as a separate word.
      if (name === 'sed' && (a === '-i' || a === '-I') && dequote(args[i + 1] ?? 'x') === '') i++;
    }
    // A bundled script switch (`-pe`, `-ne`) takes the next word as the script.
    if (name in IN_PLACE && /^-[A-Za-z0-9]+[eE]$/.test(a) && !/^--/.test(a)) { scriptGiven = true; i++; }
  }

  if (name === 'tee') return operands.length ? operands.map((p) => [p, true]) : null;
  // Without -n/-h/-T, an ln or mv onto a link to a directory writes INSIDE that directory.
  const destIsLink = args.some((a) => /^-[A-Za-z]*[nhT]/.test(a) || a === '--no-dereference' || a === '--no-target-directory');
  if (name === 'mv' && !target && operands.length > 1)
    return [...operands.slice(0, -1).map((p) => [p, false]), [operands[operands.length - 1], !destIsLink]];
  if (OPERAND_WRITERS.has(name)) {
    const refGiven = args.some((a) => a === '--reference' || a.startsWith('--reference='));
    const paths = MODE_FIRST.has(name) && !refGiven ? operands.slice(1) : operands;
    return paths.map((p) => [p, !ON_THE_LINK.has(name) && name !== 'mv']);
  }
  if (DEST_WRITERS.has(name)) {
    if (target) return [[target, true]];
    if (name === 'ln' && operands.length === 1) return [];
    return operands.length ? [[operands[operands.length - 1], name !== 'ln' || !destIsLink]] : [];
  }
  if (name in IN_PLACE) {
    if (!inPlace) return null;
    return (scriptGiven ? operands : operands.slice(1)).map((p) => [p, true]);
  }
  if (PACKAGE_MANAGERS.has(name)) return packageWrite(name, args);
  return null;
}

function packageWrite(name, args) {
  if (args.some((a) => a === '--dry-run' || a === '-g' || a === '--global')) return null;
  let prefix = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    const eq = a.indexOf('=');
    if (a.startsWith('-') && eq !== -1) {
      if (PACKAGE_DIR_FLAGS.has(a.slice(0, eq))) prefix = a.slice(eq + 1);
      continue;
    }
    if (PACKAGE_VALUE_FLAGS.has(a)) {
      const value = args[++i] ?? null;
      if (PACKAGE_DIR_FLAGS.has(a)) prefix = value;
      continue;
    }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  // Any positional, not just the first: an unknown value flag (`-w pkg`) or `yarn workspace <name>`
  // would otherwise pose as the subcommand. A script run is never an install, whatever its args.
  if (SCRIPT_RUNS.has(positional[0])) return null;
  const writes =
    (positional.length === 0 && name === 'yarn' && !args.some((a) => YARN_QUERIES.has(a))) ||
    positional.some((p, k) => {
      const next = positional[k + 1];
      if (p === 'pkg') return ['set', 'delete', 'fix'].includes(next);
      if (p === 'audit') return next === 'fix';
      if (p === 'version') return next !== undefined;
      return PACKAGE_WRITES.has(p);
    });
  if (!writes) return null;
  // node_modules too: a worktree's is routinely a link into the primary's.
  const root = prefix ?? '.';
  return [[root, true], [`${root}/node_modules`, true]];
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
