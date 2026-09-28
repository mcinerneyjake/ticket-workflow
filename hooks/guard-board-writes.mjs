#!/usr/bin/env node
// PreToolUse(Edit|Write|NotebookEdit) guardrail — a board's ticket and event files are written
// through the ticket tools, never edited as files (tkt-482f9c7cc7a5).
//
// SCOPE, and what was already covered. guard-worktree refuses Edit/Write into any repo's PRIMARY
// checkout, and a board's tickets/ and events/ live only there — so an ARMED session (one that has
// called start_ticket) was already covered, incidentally. This guard exists for the session that
// never claimed a ticket, which nothing arms and nothing judged.
//
// TWO PREDICATES, UNIONED, because each one's hole is the other's case — a single predicate here is
// the whole design risk:
//   SHAPE is root-independent: a `tkt-<12 hex>.md` directly inside a directory named `tickets` (or
//   `tkt-<12 hex>.jsonl` inside `events`). It catches an absolute write from a session whose cwd
//   resolves to a DIFFERENT board, the common shape for an unarmed session in another repo.
//   ROOT resolves the board dirs from the environment: any file inside them, whatever its name.
//   It catches what shape cannot — list_tickets parses every .md in tickets/, so an unparseable
//   `scratch.md` lands in `unreadable` and silently shrinks every count the envelope reports, and
//   `tickets/.history/` (the board's only undo) is nested too deep for shape to see.
// Testing them only together could not tell a union from an intersection, so the suite drives each
// with the other's inputs deliberately unsatisfied.
//
// WHY THE ROOT PREDICATE NEEDS A DECLARED OR EVIDENCED BOARD — it over-blocked, measured. The first
// cut fired it on the bare `CLAUDE_PROJECT_DIR`/cwd fallback, and src/paths.ts notes Claude Code
// sets CLAUDE_PROJECT_DIR in the hooks' environment of EVERY session. So in any repo whose
// `tickets/` is ordinary documentation, every Edit into it was refused for the whole session:
// `/repo/tickets/README.md` blocked, `/repo/events/index.ts` blocked. The 12-hex id shape was
// offered here as the reason that could not happen; it is the reason the SHAPE half cannot, and says
// nothing about this one. A guard whose failure mode is wedging an unrelated repo is not a safer
// guard. So the root half now fires only where the board is DECLARED (an explicit
// BOARD_DIR_OVERRIDE/TICKETS_DIR_OVERRIDE/EVENTS_DIR_OVERRIDE, which is somebody saying "this is the
// board" — CLAUDE_PROJECT_DIR only says "this is the repo I am in") or EVIDENCED (the directory
// actually holds a `tkt-<12 hex>` file). An unreadable directory yields no evidence and so does not
// block: permissive, deliberately, because the alternative is the denial of service above and the
// shape half still covers every real board file.
//
// CASE IS FOLDED ON BOTH HALVES, because this package is developed and run on macOS, whose default
// filesystem is case-insensitive: `<board>/Tickets/tkt-….md` opens the same inode as
// `<board>/tickets/tkt-….md`, and a byte comparison let one capital letter defeat the whole guard
// (measured — the write through `Tickets/` overwrote the file in `tickets/`). Folding always, rather
// than per-platform, costs only an over-block of a genuinely distinct `Tickets/` on a case-sensitive
// filesystem — a board-shaped path either way, and the wrong direction to fail is the other one.
//
// FAIL DIRECTIONS, opposite on purpose:
//   Unreadable/unparseable PAYLOAD -> BLOCK. guard-worktree-precheck.mjs is already wired on this
//   same matcher set and already exits 2 here, so this direction spends no availability that is not
//   spent, and the alternative is a guard reporting success on a call it never judged.
//   Parsed payload naming NO path -> ALLOW, knowingly. Same trade as guard-worktree's armedState on
//   a malformed session id: wedging every Edit on the machine over a payload shape we cannot
//   attribute is the worse failure. A RESIDUAL, not a guarantee.
//
// NO CONSUMER OVERRIDE, unlike guard-ticket's TICKET_WORKFLOW_CREATE_REASON. That seam exists
// because the intake MECHANISM is consumer-specific; the route here is `update_ticket`, this
// package's own MCP tool, present in every consumer. A configurable message would add a way to get
// it wrong and buy nothing.
//
// RESIDUALS — stated, never called containment:
//   - A NON-ID-NAMED file in ANOTHER repo's board. Shape needs the id, and root needs that board to
//     be the one this session's environment resolves, so with the session in repo A and a board in
//     repo B, `…/repoB/tickets/scratch.md` and `…/repoB/tickets/.history/<id>/v1.md` are both
//     allowed. Closing it would mean discovering every board on the machine, which nothing here can
//     do. The union covers each half's hole only WITHIN one resolved board.
//   - Shell writes. `sed -i`, `>`, heredocs and anything inside `$(…)` reach no PreToolUse Edit/Write
//     hook at all, and guard-bash does not judge them either. Unchanged by this guard.
//   - It guards the TOOL, not the data: a direct fs write, a script calling the service layer, or an
//     HTTP call to a board route never reaches a hook. Same first limit as guard-ticket.mjs.
//   - The wiring is machine-local user-scope config and unversioned, so "guarded" is a claim about a
//     machine, never about this repository.
//   - A board reached through a SYMLINK whose resolved path is elsewhere: paths are normalised, not
//     realpath'd, because realpath on a nonexistent target throws and a Write legitimately creates
//     one. Shape still catches the common spelling.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isMain } from './lib/is-main.mjs';

const TAG = '[guard-board-writes]';

// MUST match shared/constants.ts BRANCH_TICKET_ID_RE — a parity test asserts it, the same pin
// track-steps.mjs carries for its own copy. Without one, an id-format change silently stops the
// shape predicate matching, which is a fail-open with nothing red.
const TICKET_ID = 'tkt-[0-9a-f]{12}';
const TICKET_FILE = new RegExp(`^${TICKET_ID}\\.md$`, 'i');
const EVENT_FILE = new RegExp(`^${TICKET_ID}\\.jsonl$`, 'i');
const BOARD_FILE = new RegExp(`^${TICKET_ID}\\.(md|jsonl)$`, 'i');

export const REASON =
  'Direct writes to a ticket-workflow board file are blocked: this path is a ticket or event file. ' +
  'Write it through the board tools instead — update_ticket for body and structured fields ' +
  '(appendBody for body text), start_ticket, archive_ticket, delete_ticket — so the change is ' +
  'validated, its provenance is recorded, and a concurrent session cannot be clobbered. This hook is ' +
  'wired on Edit/Write/NotebookEdit, and it judges the path rather than the tool. If this file is not ' +
  'board data, it is matched either by its name (tkt-<12 hex>.md under tickets/, tkt-<12 hex>.jsonl ' +
  'under events/) or by sitting inside a declared board root — rename or move it rather than routing ' +
  'around this guard.';

/**
 * The board's [tickets, events] directories, each with whether the board was DECLARED rather than
 * merely inferred. Precedence follows src/paths.ts; the paths are resolved against THIS process's
 * cwd, where src/paths.ts returns a relative override raw for the MCP server to resolve against its
 * own (undocumented) cwd — so for a relative override the two can disagree, and this is not the
 * "exactly" the first draft of this comment claimed.
 *
 * `||` not `??`, as that file documents: an empty-string override must fall through, not be taken as
 * an authoritative empty path (which resolves the board to a relative `tickets` under cwd). The same
 * emptiness is what `declared` reads, so `BOARD_DIR_OVERRIDE=""` declares nothing either.
 */
export function boardDirs(env = process.env) {
  const rootDeclared = Boolean(env.BOARD_DIR_OVERRIDE);
  const root = env.BOARD_DIR_OVERRIDE || env.CLAUDE_PROJECT_DIR || process.cwd();
  return [
    { dir: path.resolve(env.TICKETS_DIR_OVERRIDE || path.join(root, 'tickets')), declared: rootDeclared || Boolean(env.TICKETS_DIR_OVERRIDE) },
    { dir: path.resolve(env.EVENTS_DIR_OVERRIDE || path.join(root, 'events')), declared: rootDeclared || Boolean(env.EVENTS_DIR_OVERRIDE) },
  ];
}

/** Case-folded: see "CASE IS FOLDED" above — a byte comparison is a one-capital-letter bypass here. */
const fold = (s) => s.toLowerCase();

/** Normalised, not resolved: the parent must be read after `sub/..` collapses, and cwd is irrelevant. */
function matchesShape(target) {
  const normalized = path.normalize(target);
  const parent = fold(path.basename(path.dirname(normalized)));
  const base = path.basename(normalized);
  return (parent === 'tickets' && TICKET_FILE.test(base)) || (parent === 'events' && EVENT_FILE.test(base));
}

/** Evidence that an undeclared directory really is a board. Unreadable → no evidence → no block. */
function holdsBoardFile(dir) {
  try {
    return readdirSync(dir).some((name) => BOARD_FILE.test(name));
  } catch {
    return false;
  }
}

function insideBoard(target, env) {
  const absolute = fold(path.resolve(target));
  return boardDirs(env).some(({ dir, declared }) => {
    const rel = path.relative(fold(dir), absolute);
    // Segment-wise, never a string prefix: `tickets-archive/` shares a prefix with `tickets/` and is
    // not inside it. Comparing the first segment to '..' rather than calling startsWith keeps a real
    // child named `..hidden` inside.
    if (rel === '' || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') return false;
    return declared || holdsBoardFile(dir);
  });
}

/** NotebookEdit names its target notebook_path; reading only file_path would let it straight through. */
function targetPath(payload) {
  const input = payload?.tool_input;
  if (typeof input !== 'object' || input === null) return null;
  for (const key of ['file_path', 'notebook_path']) {
    if (typeof input[key] === 'string' && input[key] !== '') return input[key];
  }
  return null;
}

// The PATH is the verdict, not the tool name: the settings matcher is what scopes this hook, and
// depending on it again here would make the guard silently weaker if the matcher ever widened.
export function decide(payload, env = process.env) {
  const target = targetPath(payload);
  if (target === null) return { blocked: false }; // documented residual — see FAIL DIRECTIONS
  if (matchesShape(target) || insideBoard(target, env)) return { blocked: true, reason: REASON };
  return { blocked: false };
}

export function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write(`${TAG} Blocked: the hook payload could not be read, so this write could not be judged.\n`);
    process.exit(2);
  }
  const { blocked, reason } = decide(payload);
  if (blocked) {
    process.stderr.write(`${TAG} Blocked: ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Run the I/O wiring only when invoked directly as the hook (not when imported by the test).
if (isMain(import.meta.url)) {
  main();
}
