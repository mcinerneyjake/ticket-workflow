#!/usr/bin/env node
// PreToolUse(mcp__kanban__create_ticket) guardrail — wired in .claude/settings.json.
//
// Enforces the "Ticket creation flow" split (tkt-2492e26a277a): every NEW ticket
// must be authored by the consumer's configured intake path, so its
// title/body/classification is written inside a metered run and the ticket
// carries a real usage record. The agent therefore never calls create_ticket
// itself — this hook blocks it and points at that path instead.
//
// The concrete command lives in TICKET_WORKFLOW_CREATE_REASON, set by the
// consumer, never here: this guard is wired at USER scope, so it fires in every
// repo on the machine while any specific command exists in one of them
// (tkt-0361525dbf9f).
//
// SCOPE (deliberately narrow — creation only): this blocks create_ticket and
// nothing else. Claude keeps update_ticket (implementation summaries, structured
// fields, directed edits) and delete_ticket — routing those through the agent
// would break the mandatory `## Implementation summary` step (the agent authors
// intake from a report; it can't summarize work Claude just did, nor target a
// specific ticket). See CLAUDE.md → Ticket creation flow.
//
// REACH (best-effort, like guard-bash — not an adversarial sandbox): wired at
// USER scope, this guards the MCP tool create_ticket in EVERY repo the session
// touches, not just the one it was installed from (tkt-80e348e4ff22). Two limits
// remain, and both are real:
//
//   1. It guards the MCP TOOL, not the data. An HTTP POST to the board's create
//      route, or a script calling the service layer directly, never reaches a
//      PreToolUse hook at all. Rejecting un-metered creates server-side is the
//      only thing that would close that.
//   2. The user-scope wiring is MACHINE-LOCAL and unversioned. A fresh clone on
//      another machine, a container, or CI has no guard whatsoever, and nothing
//      in this package or its consumers can detect the absence — the same caveat
//      that applies to the track-steps writer and guard-subagent-gates.
//
// So "guarded everywhere" is true of this machine, not of this repository
// (tkt-05ebe3a365cf).
//
// CONTRAST with guard-bash: guard-bash matches ALL Bash and fails OPEN on a
// parse error (most Bash is legitimate — a guardrail must never wedge real work).
// This hook is routed by the settings matcher to EXACTLY ONE tool
// (mcp__kanban__create_ticket), so it fails CLOSED: an unreadable/absent tool
// name is treated as the create call and blocked — the matcher is the evidence
// it IS create_ticket, and blocking the one guarded tool can't wedge anything
// else. (A guard that can't check must never return the permissive answer.)
//
// Protocol: read the hook payload as JSON on stdin, inspect `tool_name`. Exit 0
// to allow; exit 2 to block (stderr is surfaced to Claude so it self-corrects).
// The pure `decide` is exported for unit tests; the stdin/exit wiring runs only
// when this file is executed directly as the hook entrypoint.

import { readFileSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';

// Matches the create tool whether named `mcp__kanban__create_ticket` (the real
// tool id) or a bare `create_ticket`, so the check survives a server rename and
// documents intent independently of the settings matcher.
const CREATE_TICKET = /(?:^|__)create_ticket$/;

// The shipped default is deliberately REPO-AGNOSTIC. This guard is wired at user scope, so it fires in
// every repo on the machine, while a consumer's intake script exists in exactly one of them — a blocked
// session elsewhere was being handed a command that does not exist there (tkt-0361525dbf9f).
// It states the POLICY (which is universal) and defers the mechanism to the consumer.
export const REASON =
  'create_ticket is blocked: new tickets must be authored by this machine\'s configured intake path, ' +
  'not directly by the agent, so every new ticket carries a real usage record. Ask the user how ' +
  'tickets are filed in this repo, or read its CLAUDE.md — do NOT author the ticket yourself, which ' +
  'would create an untracked one. update_ticket (implementation summaries, structured fields, directed ' +
  'edits) and delete_ticket are unaffected. A consumer can replace this message with its own concrete ' +
  'command by setting TICKET_WORKFLOW_CREATE_REASON.';

/**
 * The message a blocked session reads. Consumer-specific vocabulary belongs HERE, in the consumer's
 * environment, not in shipped code — same seam as guard-bash's TICKET_WORKFLOW_PROTECTED_BRANCH.
 *
 * Blank/whitespace-only falls through to the default rather than blocking with an empty explanation: a
 * guard that refuses without saying why is barely better than one that fails open, and an unset-vs-empty
 * env var is a distinction no caller intends.
 */
export function createReason(env = process.env) {
  const override = env.TICKET_WORKFLOW_CREATE_REASON?.trim();
  return override || REASON;
}

export function decide(payload, env = process.env) {
  const reason = createReason(env);
  const toolName = payload?.tool_name;
  // Fail CLOSED (see header): no readable tool name → treat as the routed create call.
  if (typeof toolName !== 'string') return { blocked: true, reason };
  if (CREATE_TICKET.test(toolName)) return { blocked: true, reason };
  return { blocked: false };
}

export function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    payload = {}; // unparseable → decide() fails closed (matcher already scoped us to create_ticket)
  }
  const { blocked, reason } = decide(payload);
  if (blocked) {
    process.stderr.write(`[guard-ticket] Blocked: ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Run the I/O wiring only when invoked directly as the hook (not when imported by the test).
if (isMain(import.meta.url)) {
  main();
}
