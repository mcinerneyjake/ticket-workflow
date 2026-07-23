#!/usr/bin/env node
// PreToolUse(mcp__kanban__create_ticket) guardrail — wired in .claude/settings.json.
//
// Enforces the CLAUDE.md "Ticket creation flow" split (tkt-2492e26a277a): every
// NEW ticket must be authored by the local intake agent (`npm run agent`), so its
// title/body/classification is written inside a metered local-LLM run and the
// ticket carries a real usage record. Claude therefore never calls create_ticket
// itself — this hook blocks it and points Claude at the agent instead.
//
// SCOPE (deliberately narrow — creation only): this blocks create_ticket and
// nothing else. Claude keeps update_ticket (implementation summaries, structured
// fields, directed edits) and delete_ticket — routing those through the agent
// would break the mandatory `## Implementation summary` step (the agent authors
// intake from a report; it can't summarize work Claude just did, nor target a
// specific ticket). See CLAUDE.md → Ticket creation flow.
//
// REACH (best-effort, like guard-bash — not an adversarial sandbox): this guards
// the MCP tool create_ticket in THIS repo's project scope only. A direct
// POST /api/tickets or a service-layer createTicket script bypasses it, and
// sessions in other repos driving the central board via the user-scope server
// aren't guarded until it's wired there too. See CLAUDE.md → Ticket creation
// flow (Scope of enforcement).
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
import { pathToFileURL } from 'node:url';

// Matches the create tool whether named `mcp__kanban__create_ticket` (the real
// tool id) or a bare `create_ticket`, so the check survives a server rename and
// documents intent independently of the settings matcher.
const CREATE_TICKET = /(?:^|__)create_ticket$/;

export const REASON =
  'create_ticket is authored by the local intake agent, not Claude, so every new ticket ' +
  'carries a metered local-LLM usage record. Run `npm run agent -- --yes "<report>"` — it ' +
  'writes the title + body and classifies type/priority/status/project inside a metered run. ' +
  'If the local model is unavailable (agent exits non-zero / GET /api/intake/health is down), ' +
  'tell the user the local runtime is unavailable — do NOT author the ticket yourself (that ' +
  'would create an untracked ticket). update_ticket (summaries, structured fields, edits) and ' +
  'delete_ticket remain Claude\'s. See CLAUDE.md → Ticket creation flow.';

export function decide(payload) {
  const toolName = payload?.tool_name;
  // Fail CLOSED (see header): no readable tool name → treat as the routed create call.
  if (typeof toolName !== 'string') return { blocked: true, reason: REASON };
  if (CREATE_TICKET.test(toolName)) return { blocked: true, reason: REASON };
  return { blocked: false };
}

function main() {
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
