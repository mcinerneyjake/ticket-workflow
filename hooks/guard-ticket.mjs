#!/usr/bin/env node
// PreToolUse(mcp__kanban__create_ticket) guardrail — wired at user scope (a consumer may add a project-scope entry).
//
// Enforces the "Ticket creation flow" split (tkt-2492e26a277a): every NEW ticket
// must be authored by the consumer's configured intake path, so its
// title/body/classification is written inside a metered run and the ticket
// carries a real usage record. The agent therefore never calls create_ticket
// itself — this hook blocks it and points at that path instead.
//
// ONE EXCEPTION (tkt-5a450d4a3ee8): a create whose self-asserted `parent` is an OPEN spec ticket, read
// from the board THIS process resolves (src/paths.ts), is admitted; anything it cannot judge blocks.
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
// CONTRAST with guard-bash runs at TWO levels — do not collapse them into one.
// Unreadable PAYLOAD: both fail CLOSED (guard-bash since v0.25.0, tkt-92360b0e2079).
// Missing FIELD on a payload that parsed: they diverge, deliberately. guard-bash
// ALLOWS a command-less event (its `decide`), because matching ALL Bash means it
// also fires for BashOutput, whose events legitimately carry no command — blocking
// there would wedge the session. This hook's matcher routes EXACTLY ONE tool
// (mcp__kanban__create_ticket), so an absent tool_name can only be the routed create
// call: blocking it costs that one tool and nothing else. REACH is what makes the
// two differ — not one of them taking "I cannot tell" less seriously than the other.
// (A guard that can't check must never return the permissive answer.)
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

// MUST match shared/constants.ts BRANCH_TICKET_ID_RE (parity test). Stricter than the service's own
// id check on purpose: a case variant reads the same file on a case-insensitive disk.
export const TICKET_ID = /^tkt-[0-9a-f]{12}$/;
const CLOSED_STATUSES = new Set(['done', 'archived']);
// A hung read (stalled mount, FIFO, evicted cloud file) must block before the harness's hook timeout,
// which would otherwise end the hook without a verdict.
const READ_DEADLINE_MS = 5_000;

/** Why `parent` does or does not admit a create. Never throws: an error reading the parent is a refusal. */
export async function specParentVerdict(parent, getTicket, deadlineMs = READ_DEADLINE_MS) {
  if (typeof parent !== 'string' || !TICKET_ID.test(parent)) return { admit: false, why: `parent ${JSON.stringify(parent)} is not a current-format ticket id (tkt-<12 hex>)` };
  let ticket;
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${deadlineMs}ms`)), deadlineMs);
    });
    ticket = await Promise.race([getTicket(parent), deadline]);
  } catch (err) {
    return { admit: false, why: `parent ${parent} could not be read (${err?.message ?? String(err)})` };
  } finally {
    clearTimeout(timer);
  }
  if (ticket?.spec == null) return { admit: false, why: `parent ${parent} is not a spec ticket (no valid spec field)` };
  if (typeof ticket.status !== 'string' || CLOSED_STATUSES.has(ticket.status)) return { admit: false, why: `parent ${parent} is a closed spec ticket (status ${ticket.status})` };
  return { admit: true, why: `parent ${parent} is an open spec ticket` };
}

// Lazy, so a create with no parent never loads the service layer. A missing build is a throw → block.
// The service logs parse errors with a snippet of the file; on exit 2 stderr reaches the model, so mute it.
async function loadGetTicket() {
  const logger = await import(new URL('../dist/logger.js', import.meta.url).href);
  if (typeof logger.setLogger !== 'function') throw new TypeError('dist/logger.js exports no setLogger');
  const silent = () => {};
  logger.setLogger({ info: silent, warn: silent, error: silent });
  const tickets = await import(new URL('../dist/server/tickets.js', import.meta.url).href);
  if (typeof tickets.getTicket !== 'function') throw new TypeError('dist/server/tickets.js exports no getTicket');
  return tickets.getTicket;
}

/** decide() plus the spec-parent exception. The only path to an admitted create. */
export async function judge(payload, env = process.env, load = loadGetTicket) {
  const base = decide(payload, env);
  if (!base.blocked || typeof payload?.tool_name !== 'string') return base;
  const parent = payload.tool_input?.parent;
  // No parent → the unchanged message: advertising the exception to every ad-hoc create invites a
  // session to attach any open spec ticket just to skip intake.
  if (parent === undefined || parent === null) return base;
  let verdict;
  try {
    // A spec ticket is filed through intake; admitting one here would let it parent further creates.
    verdict = payload.tool_input?.spec != null
      ? { admit: false, why: 'a create carrying `spec` is a spec ticket, which is filed through intake' }
      : await specParentVerdict(parent, await load());
  } catch (err) {
    verdict = { admit: false, why: `the board service could not be loaded (${err?.message ?? String(err)})` };
  }
  if (verdict.admit) return { blocked: false };
  return { blocked: true, reason: `${base.reason}\nSpec-parent exception not met: ${verdict.why}.` };
}

export async function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    payload = {}; // unparseable → decide() fails closed (matcher already scoped us to create_ticket)
  }
  const { blocked, reason } = await judge(payload);
  if (blocked) {
    process.stderr.write(`[guard-ticket] Blocked: ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Run the I/O wiring only when invoked directly as the hook (not when imported by the test).
// An unhandled rejection exits 1, which the hook protocol reads as ALLOW.
if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`[guard-ticket] Blocked: the guard failed (${err?.message ?? String(err)}).\n`);
    process.exit(2);
  }
}
