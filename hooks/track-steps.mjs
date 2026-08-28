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
// milestone(s) and the DELIVERED EVENT to pass/fail. `tool_response` carries no
// exit status of any kind — `PostToolUse` fires only when a tool call succeeds
// and a failed one is dispatched to `PostToolUseFailure`, a separate
// subscription, so the event name is the whole outcome signal (tkt-31f693ac8bb0).
// The mapping functions (commandToMilestones / extractTicketId / stateFromEvent)
// are exported and pure so they can be unit-tested without spawning a
// subprocess; the stdin/append wiring runs only when this file is executed
// directly as the hook entrypoint.

import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { dirTarget, hasTopLevelBackground, hasTopLevelPipe, hiddenDirMove, resolveDir, splitSegmentsWithOps, subshellParens } from './lib/shell.mjs';

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

// Every milestone a command records, in first-seen order, each paired with the directory it acted
// on: a resolved absolute path, or `undefined` when the command neither moved nor named one and so
// acts on the caller's own cwd by construction.
//
// A milestone belongs to the ticket named by the branch of the repo it RAN IN — not the session's.
// Attributing by the session's branch filed foreign work under whatever ticket that branch happened
// to name: a real ticket showing a pipeline it never ran (tkt-2734584f8715). Refusing those closed
// the corruption but left a gap, since the work did happen and does belong somewhere; resolving the
// directory here lets the caller find that somewhere (tkt-8ada0242e94e).
//
// An UNRESOLVABLE directory records nothing, and is dropped here rather than returned: a caller
// that received it could only guess, and the one guess available — the session — is the original
// bug. "Can't tell" must never take the permissive branch. Unresolvable covers `cd -`, `popd`, a
// quoted or whitespace-split path, a variable, and a move hidden behind a pipeline.
//
// WHAT THAT LIST DOES NOT COVER, and it is a real cost of attributing rather than refusing: a `cd`
// that is DATA still parses as a move, and is now credited to the directory it names instead of
// being dropped. Two spellings do it — `VAR=$( cd /x && … )` (the space matters; `$(cd` and
// `export VAR=$( cd` both read correctly), because dirBuiltin is deliberately not
// substitution-aware; and a heredoc body line, because splitSegments splits on newline. Under the
// refuse-everything predecessor both merely dropped. The root cause is shared with guard-bash via
// dirTarget and is tkt-b9c0eda6c630, whose two previous fixes were reverted as fail-opens — so it
// is not a rider on this. A wrongly-named directory only misfiles if it is a real repo whose
// branch names a real ticket; otherwise it still drops.
//
// Segment splitting, directory tracking and subshell restore are guard-bash's, via lib/shell.mjs:
// the naive split let quoted data (`echo "x && cd /elsewhere && npm test"`) forge a segment, and
// without the `outer` stack a subshell that cd'd away stayed away after it exited. `dirTarget`
// widens guard-bash's `cd` to `pushd`/`popd` — see its comment for why the two hooks differ.
//
// KNOWN RESIDUAL: the Bash tool's cwd can persist ACROSS tool calls, and `payload.cwd` is the
// project dir (guard-bash.mjs says so, verified 2026-07-15), so a `cd` in one call followed by a
// bare `npm test` in the next arrives here with no directory segment at all and is attributed to
// the session. That shape is invisible in the payload; nothing below can close it.
export function commandToMilestones(command, startDir) {
  if (typeof command !== 'string' || !command.trim()) return [];

  const segs = splitSegmentsWithOps(command);
  // Whether each segment's OWN exit status reaches the tool call. The last segment's does; an
  // earlier one's does only through an unbroken `&&` chain to it, because `;` and `||` both run what
  // follows regardless of how it went. Kept separate from the pipe/background test below because a
  // masked segment still passes the chain on: in `a && (b | c)` the command succeeding still proves
  // `a` exited 0, even though it was c's exit the tool reported (tkt-31f693ac8bb0).
  //
  // Two ways a segment's status fails to reach the caller even so, both of which record `passed`
  // for work that never happened if ignored:
  //   - it sits after `||`, so it runs only when its predecessor FAILED. `gh pr view || gh pr
  //     create` exits 0 with `gh pr create` never executed.
  //   - anything in the command backgrounds. A bare `&` backgrounds the whole AND-OR list it
  //     terminates, not merely the segment holding it, so `npm run lint && npm test &` returns 0
  //     before `lint` has finished. Disqualifying the entire command is deliberately broader than
  //     the shell's own scoping: it drops telemetry, which is the recoverable direction.
  const backgrounded = segs.some((seg) => hasTopLevelBackground(seg.text));
  const chainToEnd = new Array(segs.length).fill(false);
  for (let i = segs.length - 1; i >= 0; i--) {
    const ranUnconditionally = i === 0 || segs[i - 1].opAfter !== '||';
    const reachesEnd = i === segs.length - 1 || (segs[i].opAfter === '&&' && chainToEnd[i + 1]);
    chainToEnd[i] = !backgrounded && ranUnconditionally && reachesEnd;
  }

  const found = [];
  let dir = typeof startDir === 'string' ? startDir : null;
  // Tracked SEPARATELY from `dir`, never inferred from it: with `cd -` (unresolvable -> null) and a
  // null startDir, a `dir === startDir` test reads as "never moved" and would report the session.
  // Two different unknowns must not compare equal.
  let moved = false;
  const outer = []; // [dir, moved] saved at `(` — a real shell restores cwd when the subshell exits
  for (let si = 0; si < segs.length; si++) {
    const segment = segs[si].text;
    const exitObservable = chainToEnd[si] && !hasTopLevelPipe(segment);
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
        // A named directory is resolved even from an unmoved cwd: `npm test --prefix <other>` never
        // moved the shell, yet it ran in another repo.
        if (!moved && !named) found.push({ step: hit.step, dir: undefined, exitObservable });
        else {
          const actsOn = !named ? dir : (hit.dirToken === null ? null : resolveDir(dir, hit.dirToken));
          if (actsOn !== null) found.push({ step: hit.step, dir: actsOn, exitObservable });
        }
      }
    }

    for (let i = parens.close; i > 0 && outer.length; i--) [dir, moved] = outer.pop();
  }

  // Deduped per directory, not globally: the same step in two repos is two milestones, and only the
  // caller can tell whether two directories are one repo.
  // Observability is OR'd across duplicates rather than taken from the first: in
  // `npm test | tail && npm test` the same step is masked once and observable once, and the second
  // run really did exit 0.
  const seen = new Map();
  const deduped = [];
  for (const m of found) {
    const key = `${m.dir ?? ''}\u0000${m.step}`;
    const prev = seen.get(key);
    if (prev) {
      if (m.exitObservable) prev.exitObservable = true;
      continue;
    }
    const rec = { ...m };
    seen.set(key, rec);
    deduped.push(rec);
  }
  return deduped;
}

// Segments that are neither a directory move nor a recognised milestone. On a FAILED event these
// are candidates the failure could belong to and that nothing in the payload can name, so their
// presence makes the failure unattributable: `npm ci && npm test` carries ONE milestone, and
// crediting `test: failed` to it when `npm ci` was what broke accuses a gate that never ran
// (tkt-31f693ac8bb0). A directory builtin is excluded because `cd <target> && npm test` is the
// workflow's own foreign-mode form; a failing `cd` misattributes, which is the fail-closed
// direction and is the price of recording that shape at all.
export function opaqueSegments(command) {
  if (typeof command !== 'string') return 0;
  let n = 0;
  for (const { text } of splitSegmentsWithOps(command)) {
    if (dirTarget(text, null) !== undefined || hiddenDirMove(text)) continue;
    if (matchStep(tokenize(text))) continue;
    n++;
  }
  return n;
}

// The ticket id embedded in a <type>/<id>-<slug> branch name, or null when the
// branch carries none (e.g. main, or a detached HEAD). MUST match
// shared/constants.ts BRANCH_TICKET_ID_RE — a parity test asserts it.
export function extractTicketId(branch) {
  if (typeof branch !== 'string') return null;
  const m = branch.match(/tkt-[0-9a-f]{12}/);
  return m ? m[0] : null;
}

// The delivered hook event -> milestone state, or null when this hook cannot know the outcome.
// `null` is the whole point: the payload carries no exit status, so an unrecognised event has no
// outcome to report, and `passed` is the permissive answer that produced 4,635 command milestones
// with zero failures among them (tkt-31f693ac8bb0).
export function stateFromEvent(eventName) {
  if (eventName === 'PostToolUse') return 'passed';
  if (eventName === 'PostToolUseFailure') return 'failed';
  return null;
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
  // Provenance, not decoration: `verify` must be able to tell a row whose state came from the
  // delivered event from the pre-fix rows that said `passed` regardless. A DATE cannot do it — the
  // writer is per-machine and unversioned, so a machine that never bumps its pin keeps writing
  // success-only rows that a cutover date would start trusting (tkt-31f693ac8bb0).
  const line = `${JSON.stringify({ ticketId, step, state, at, outcomeFrom: 'event' })}\n`;
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
    const state = stateFromEvent(payload?.hook_event_name);
    const milestones = state === null ? [] : commandToMilestones(payload?.tool_input?.command, startDir);
    // On failure the shell stopped at SOME command and nothing in the payload says which, so the
    // failure is attributable only when the command carries exactly one milestone to attribute it
    // to. On success an unbroken `&&` chain proves every link exited 0, so each is recorded.
    const command = payload?.tool_input?.command;
    const unattributableFailure =
      state === 'failed' && (milestones.length !== 1 || opaqueSegments(command) > 0);
    const attributable = unattributableFailure ? [] : milestones.filter((m) => m.exitObservable);
    if (attributable.length > 0) {
      const at = new Date().toISOString();
      // Resolved PER milestone, not once for the command: one compound command can legitimately
      // touch two repos, and each half belongs to its own repo's ticket (tkt-8ada0242e94e).
      // Memoized by directory, so the ordinary single-directory command still spawns one git.
      const branchTicket = new Map();
      const ticketFor = (d) => {
        const from = d ?? startDir; // `undefined` => the session's cwd, by construction
        if (!branchTicket.has(from)) branchTicket.set(from, extractTicketId(currentBranch(from)));
        return branchTicket.get(from);
      };
      // Grouped so recordsFor sees each ticket's own steps in order — it inserts `review` before a
      // passing `commit`, which must land on the ticket that was committed, not the session's.
      const byTicket = new Map();
      for (const { step, dir } of attributable) {
        const ticketId = ticketFor(dir);
        if (!ticketId) continue; // no repo, or a branch naming no ticket => nothing to attribute to
        const steps = byTicket.get(ticketId) ?? [];
        // Two directories can be one repo (a subdirectory), so the same step can arrive twice.
        if (!steps.includes(step)) steps.push(step);
        byTicket.set(ticketId, steps);
      }
      for (const [ticketId, steps] of byTicket)
        for (const r of recordsFor(steps, state)) record(ticketId, r.step, r.state, at);
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
