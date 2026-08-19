#!/usr/bin/env node
// PostToolUse(Bash) telemetry — wired in a consumer repo's .claude/settings.json
// alongside the PreToolUse guard-bash hook.
//
// Observes the shell commands Claude runs and records workflow-milestone "scan
// events" for the ticket-tracking UI. Each recognized command (branch cut,
// typecheck, lint, test, commit, PR open) appends one line to
// events/<ticketId>.jsonl, correlating to the ticket via the current branch name
// (<type>/<id>-<slug> — the branch IS the tracking number).
//
// CONTRAST with guard-bash: that hook BLOCKS (PreToolUse, exit 2). This one is
// pure best-effort telemetry — it CANNOT block (PostToolUse runs after the tool
// already ran) and must never disrupt the workflow: it always exits 0, never
// writes stderr, and swallows every error.
//
// Status milestones (started/qa/done) are emitted server-side by updateTicket,
// NOT here: after `gh pr merge --delete-branch` the branch is gone, so the
// branch-correlation this hook relies on wouldn't resolve the ticket anyway.
//
// Protocol: read the hook payload as JSON on stdin; map tool_input.command to
// milestone(s) and tool_response.exit_code to pass/fail. The mapping functions
// (commandToMilestones / extractTicketId / stateFromExit) are exported and pure
// so they can be unit-tested without spawning a subprocess; the stdin/append
// wiring runs only when this file is executed directly as the hook entrypoint.

import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { dirTarget, hiddenDirMove, resolveDir, splitSegments, subshellParens } from './lib/shell.mjs';

// The milestones this hook can emit. MUST stay a subset of shared/constants.ts
// STEP_IDS — track-steps.test.mjs asserts parity so the two can't drift.
// (started/qa/done are service-emitted, so they are absent here.) `review` is
// derived: a successful `git commit` implies the "Ready to commit?" review gate
// was passed, so the hook records `review` alongside `commit` (see recordsFor).
export const HOOK_STEPS = ['branch', 'typecheck', 'lint', 'test', 'commit', 'pr_opened', 'review'];

// Strip leading subshell/group punctuation and simple VAR=val env prefixes,
// returning a command segment's token list (mirrors guard-bash's parsing so
// `echo "npm run lint"` isn't mistaken for the real command).
function tokenize(segment) {
  const stripped = segment.trim().replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '');
  const tokens = stripped.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; // env prefix
  return tokens.slice(i);
}

// Directory-redirecting flags on npm/npx: `npm test --prefix <dir>`, `npx vitest run --root <dir>`.
// The positional match below keys on t[1], so these forms match no matter what follows — a guard
// hooked on `cd` alone would file them under the session's ticket while they ran somewhere else.
//
// git is deliberately NOT scanned: its `-C` is a GLOBAL option before the subcommand, so a `-C`
// after one means something else entirely (`git commit -C <commit>` reuses a message, and reading
// that as a path would drop a legitimate milestone), and the positional match never fires on the
// global form anyway. When tkt-f1c863f0f35c makes `git -C <dir> commit` matchable it must return
// its directory through this same slot, or it reopens the hole this guard closes.
const NPM_DIR_FLAGS = new Set(['--prefix', '-C']);        // npm's own
const VITEST_DIR_FLAGS = new Set(['--root', '--dir']);   // npx vitest's own
function dirToken(t, flags) {
  let found;
  for (let i = 1; i < t.length; i++) {
    // Everything after a bare `--` belongs to the invoked script, not to npm/npx: `npm test --
    // --dir coverage` names a coverage directory, and reading it as a repo dropped the milestone.
    if (t[i] === '--') break;
    const eq = t[i].indexOf('=');
    // Last match, not first: npm resolves a repeated flag last-wins, and stopping at the first one
    // would attribute `--prefix <session> --prefix <other>` to the session it never ran in.
    if (eq > 0 && flags.has(t[i].slice(0, eq))) found = t[i].slice(eq + 1) || null;
    else if (flags.has(t[i])) found = t[i + 1] ?? null;
  }
  return found; // undefined => acts on the cwd
}

// Map one command segment's tokens to { step, dirToken }, or null. `dirToken` is the RAW directory
// the command names (unresolved), undefined when it acts on the cwd, null when it names one whose
// value is missing.
function matchStep(t) {
  if (t[0] === 'git') {
    if (t[1] === 'switch' && (t.includes('-c') || t.includes('-C'))) return { step: 'branch' };
    if (t[1] === 'checkout' && (t.includes('-b') || t.includes('-B'))) return { step: 'branch' };
    if (t[1] === 'commit') return { step: 'commit' };
    return null;
  }
  if (t[0] === 'npm') {
    const d = dirToken(t, NPM_DIR_FLAGS);
    if (t[1] === 'run' && t[2] === 'typecheck') return { step: 'typecheck', dirToken: d };
    if (t[1] === 'run' && t[2] === 'lint') return { step: 'lint', dirToken: d };
    if (t[1] === 'test' || (t[1] === 'run' && typeof t[2] === 'string' && t[2].startsWith('test')))
      return { step: 'test', dirToken: d };
    return null;
  }
  if (t[0] === 'npx' && t[1] === 'vitest') return { step: 'test', dirToken: dirToken(t, VITEST_DIR_FLAGS) };
  if (t[0] === 'gh' && t[1] === 'pr' && t[2] === 'create') return { step: 'pr_opened' };
  return null;
}

// Every milestone a command records for the SESSION's repo, in first-seen order.
//
// This hook attributes by the session's branch, so a milestone from a command that ran somewhere
// else would be filed under whatever ticket that branch names — a real ticket showing a pipeline it
// never ran (tkt-2734584f8715). A segment that moved, or that named a directory, therefore records
// NOTHING unless that directory is proven to be the session's: a gap reads as a gap, while a
// misfiled row is false evidence indistinguishable from a real one. "Unproven" covers an
// unresolvable target, an absent or non-boolean predicate, and a target that resolves elsewhere —
// "can't tell" must never take the permissive branch. A segment that neither moved nor named a
// directory needs no proof and consults nothing: it is the session's cwd by construction.
//
// Segment splitting, directory tracking and subshell restore are guard-bash's, via lib/shell.mjs:
// the naive split let quoted data (`echo "x && cd <session> && npm test"`) forge a segment that
// cleared the guard, and without the `outer` stack a subshell that cd'd home stayed home after it
// exited. `dirTarget` widens guard-bash's `cd` to `pushd`/`popd` — see its comment for why the two
// hooks need different nets.
//
// KNOWN RESIDUAL: the Bash tool's cwd can persist ACROSS tool calls, and `payload.cwd` is the
// project dir (guard-bash.mjs says so, verified 2026-07-15), so a `cd` in one call followed by a
// bare `npm test` in the next arrives here with no directory segment at all and is admitted. That
// shape is invisible in the payload; nothing below can close it.
//
// `isSessionRepo` is injected to keep this pure, and is consulted ONLY for a segment that produced
// a milestone AND either moved or named a directory — so an ordinary `npm test`, and a
// non-milestone `cd sub && ls`, still reach no git subprocess at all.
export function commandToMilestones(command, startDir, isSessionRepo) {
  if (typeof command !== 'string' || !command.trim()) return [];

  const candidates = [];
  let dir = typeof startDir === 'string' ? startDir : null;
  // Tracked SEPARATELY from `dir`, never inferred from it: with `cd -` (unresolvable -> null) and a
  // null startDir, a `dir === startDir` test reads as "never moved" and admits the segment with no
  // check at all. Two different unknowns must not compare equal.
  let moved = false;
  const outer = []; // [dir, moved] saved at `(` — a real shell restores cwd when the subshell exits
  for (const segment of splitSegments(command)) {
    const parens = subshellParens(segment);
    for (let i = parens.open; i > 0; i--) outer.push([dir, moved]);

    const target = dirTarget(segment, dir);
    if (target !== undefined) {
      dir = target;
      moved = true;
    } else if (hiddenDirMove(segment)) {
      dir = null; // moved somewhere we cannot name — unresolvable, never "stayed put"
      moved = true;
    } else {
      const hit = matchStep(tokenize(segment));
      if (hit) {
        const named = hit.dirToken !== undefined;
        const actsOn = !named ? dir : (hit.dirToken === null ? null : resolveDir(dir, hit.dirToken));
        // A named directory always needs proving, even from an unmoved cwd: `npm test --prefix
        // <other>` never moved the shell, yet it ran in another repo.
        candidates.push({ step: hit.step, actsOn, needsProof: moved || named });
      }
    }

    for (let i = parens.close; i > 0 && outer.length; i--) [dir, moved] = outer.pop();
  }
  if (candidates.length === 0) return [];

  const known = new Map(); // dir -> ours?; memoized, so one lookup per repo however long the chain
  const ours = (d) => {
    if (typeof d !== 'string' || typeof isSessionRepo !== 'function') return false;
    if (!known.has(d)) known.set(d, isSessionRepo(d) === true); // non-boolean = can't tell = no
    return known.get(d);
  };

  const steps = [];
  for (const { step, actsOn, needsProof } of candidates) {
    // Nothing moved and nothing was named => the session's cwd by construction, which is what keeps
    // the common command free of git subprocesses.
    if (needsProof && !ours(actsOn)) continue;
    if (!steps.includes(step)) steps.push(step);
  }
  return steps;
}

// The ticket id embedded in a <type>/<id>-<slug> branch name, or null when the
// branch carries none (e.g. main, or a detached HEAD). MUST match
// shared/constants.ts BRANCH_TICKET_ID_RE — a parity test asserts it.
export function extractTicketId(branch) {
  if (typeof branch !== 'string') return null;
  const m = branch.match(/tkt-[0-9a-f]{12}/);
  return m ? m[0] : null;
}

// A completed command's exit code -> milestone state.
export function stateFromExit(exitCode) {
  return exitCode === 0 ? 'passed' : 'failed';
}

// The milestone records to append for a completed command. A successful
// `git commit` implies the "Ready to commit?" review gate was passed — so a
// `review` (reached) record is emitted just before the `commit`, with no
// separate step for the human/agent to remember. Pure + exported for testing.
export function recordsFor(steps, exitState) {
  const records = [];
  for (const step of steps) {
    if (step === 'commit' && exitState === 'passed') records.push({ step: 'review', state: 'reached' });
    records.push({ step, state: exitState });
  }
  return records;
}

// Same path-traversal guard as the service (server/events.ts): a crafted id can
// never escape the events dir.
const ID_RE = /^[a-zA-Z0-9-]+$/;

// Resolve the current branch of the repo the hook is acting on. Prefer the
// project dir Claude Code supplies in the payload (`cwd`) over process.cwd(), so
// branch detection is robust even if the hook process isn't launched from the
// repo root (mirrors guard-bash).
function currentBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(cwd ? { cwd } : {}),
    }).trim();
  } catch {
    return null; // detached / not a repo → can't correlate, so record nothing
  }
}

// The repo root of `dir`, or null when it is not a repo / cannot be read. Two
// dirs are the same repo when their roots match — compared by ROOT, not by
// path, so a `cd` into a subdirectory is still the session's repo.
function repoRoot(dir) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(dir ? { cwd: dir } : {}),
    }).trim() || null;
  } catch {
    return null;
  }
}

// Mirror server/paths.ts precedence so the hook and the MCP service write to the
// same per-repo events/ dir (BOARD_DIR_OVERRIDE ?? CLAUDE_PROJECT_DIR ?? cwd).
function eventsDir() {
  if (process.env.EVENTS_DIR_OVERRIDE) return process.env.EVENTS_DIR_OVERRIDE;
  // `||` not `??`: an empty-string override must fall through, matching paths.ts.
  const root = process.env.BOARD_DIR_OVERRIDE || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.join(root, 'events');
}

function record(ticketId, step, state, at) {
  if (!ID_RE.test(ticketId)) return;
  const dir = eventsDir();
  mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify({ ticketId, step, state, at })}\n`;
  appendFileSync(path.join(dir, `${ticketId}.jsonl`), line, { encoding: 'utf8', flag: 'a' });
}

export function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // unparseable event → not our concern
  }
  try {
    // Cheap match FIRST so non-milestone commands short-circuit before the
    // git subprocess — no per-command latency for the 99% that aren't gates.
    const startDir = payload?.cwd ?? process.cwd();
    // Lazy + memoized: the predicate is reached only by a milestone that moved or named a
    // directory, so an ordinary command still spawns no git subprocess at all.
    let sessionRoot;
    const isSessionRepo = (d) => {
      if (sessionRoot === undefined) sessionRoot = repoRoot(startDir);
      return sessionRoot !== null && repoRoot(d) === sessionRoot;
    };
    const steps = commandToMilestones(payload?.tool_input?.command, startDir, isSessionRepo);
    if (steps.length > 0) {
      const ticketId = extractTicketId(currentBranch(startDir));
      if (ticketId) {
        const exitCode = payload?.tool_response?.exit_code;
        const state = stateFromExit(typeof exitCode === 'number' ? exitCode : 0);
        const at = new Date().toISOString();
        for (const r of recordsFor(steps, state)) record(ticketId, r.step, r.state, at);
      }
    }
  } catch {
    // best-effort: telemetry must never disrupt the tool
  }
  process.exit(0);
}

// Run the I/O wiring only when invoked directly as the hook (not when imported
// by the test).
if (isMain(import.meta.url)) {
  main();
}
