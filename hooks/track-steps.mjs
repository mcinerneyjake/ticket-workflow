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
import { pathToFileURL } from 'node:url';

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
  const stripped = segment.trim().replace(/^[({\s]+/, '');
  const tokens = stripped.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; // env prefix
  return tokens.slice(i);
}

// Map one command segment's tokens to a single milestone step id, or null.
function matchStep(t) {
  if (t[0] === 'git') {
    if (t[1] === 'switch' && (t.includes('-c') || t.includes('-C'))) return 'branch';
    if (t[1] === 'checkout' && (t.includes('-b') || t.includes('-B'))) return 'branch';
    if (t[1] === 'commit') return 'commit';
    return null;
  }
  if (t[0] === 'npm') {
    if (t[1] === 'run' && t[2] === 'typecheck') return 'typecheck';
    if (t[1] === 'run' && t[2] === 'lint') return 'lint';
    if (t[1] === 'test' || (t[1] === 'run' && typeof t[2] === 'string' && t[2].startsWith('test')))
      return 'test';
    return null;
  }
  if (t[0] === 'npx' && t[1] === 'vitest') return 'test';
  if (t[0] === 'gh' && t[1] === 'pr' && t[2] === 'create') return 'pr_opened';
  return null;
}

// Split a (possibly compound) command on &&/||/;/newline — as guard-bash does;
// single `|` is intentionally not a split point — and collect every milestone
// it hits, in first-seen order. So `npm run typecheck && npm run lint` -> both.
export function commandToMilestones(command) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const steps = [];
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const step = matchStep(tokenize(segment));
    if (step && !steps.includes(step)) steps.push(step);
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

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // unparseable event → not our concern
  }
  try {
    // Cheap match FIRST so non-milestone commands short-circuit before the
    // git subprocess — no per-command latency for the 99% that aren't gates.
    const steps = commandToMilestones(payload?.tool_input?.command);
    if (steps.length > 0) {
      const startDir = payload?.cwd ?? process.cwd();
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
