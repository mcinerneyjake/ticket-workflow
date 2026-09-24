#!/usr/bin/env node
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { clearStaleSlots, DEFAULT_TTL_MS, formatSlot, listSlots, pidLiveness, TestRunRefusal, testSlotsStateDir } from '../test-run/slots.js';
import { listTickets, getTicket, DELETE_RECORD_FILE, type StrippedEdge } from '../server/tickets.js';
import { listHistory, restoreFromSnapshot, undeleteFromHistory } from '../server/history.js';
import { getTicketEvents } from '../server/events.js';
import { isStatusId, STATUS_IDS, type StepState } from '../shared/constants.js';
import { runChecks, exitCodeFor, formatResults } from '../doctor/checks.js';
import { gatherFacts } from '../doctor/gather.js';
import { runAudit, auditExitCode, formatAudit } from '../audit/run.js';
import { runInit } from '../init/run.js';
import { buildReport, formatReport } from '../verify/rules.js';
import { gatherTicketFacts } from '../verify/gather.js';
import { createWorktree, branchName, PREFIX_BY_TYPE } from '../worktree/create.js';
import { provisionFailed, provisionWorktree } from '../worktree/provision.js';
import { sweep } from '../vacuous/probe.js';
import { checkRoot, vacuousExitCode, EXIT as VACUOUS_EXIT } from '../vacuous/ratchet.js';
import { cmdTestContention } from './contention.js';

// Lightweight per-repo board viewer. Resolves the board from the cwd/
// CLAUDE_PROJECT_DIR (see paths.ts), so it shows whichever repo it runs in.
// Renders the pipeline from the SAME reducePipeline the web board uses, so the
// text view can't drift from the real tracker.

// Keyed exhaustively so a new state fails to compile instead of rendering as pending (tkt-24925929919c).
const GLYPH: Record<StepState | 'pending', string> = {
  passed: '✓',
  reached: '✓',
  failed: '✗',
  unattributed: '?',
  pending: '·',
};

export async function cmdList(statusFilter: string | null): Promise<void> {
  const tickets = await listTickets();
  const rows = statusFilter ? tickets.filter((t) => t.status === statusFilter) : tickets;
  if (rows.length === 0) {
    console.log('No tickets.');
    return;
  }
  for (const t of rows) {
    console.log(`${t.id}  ${t.status.padEnd(12)}  ${t.title}`);
  }
}

export async function cmdShow(id: string): Promise<void> {
  // Verify the ticket exists first — getTicket throws HttpError(404) for a missing
  // id (caught in main → exit 1). Without this, getTicketEvents on a typo'd/deleted
  // id returns an all-pending pipeline, indistinguishable from a real un-started one.
  const ticket = await getTicket(id);
  const { pipeline, skipped, unrecognized } = await getTicketEvents(id);
  console.log(`${ticket.id}  ${ticket.status}  ${ticket.title}`);
  for (const step of pipeline) {
    const glyph = GLYPH[step.state];
    const when = step.at ? `  (${step.at})` : '';
    console.log(`  ${glyph} ${step.label}${when}`);
  }
  // Without this the pipeline above renders a discarded event as a never-run step — the exact
  // ambiguity the counts exist to remove. Returning them from readEvents does NOT force a caller
  // to look: destructuring drops them and typecheck stays clean, which is how this was missed.
  if (skipped > 0) console.log(`  ! ${skipped} unreadable line(s) — steps above may be incomplete`);
  if (unrecognized > 0) console.log(`  ! ${unrecognized} line(s) written by a newer ticket-workflow`);
}

function edgeLabel(edge: StrippedEdge): string {
  const roles = [edge.blocker ? 'blocker' : null, edge.parent ? 'parent' : null].filter((r) => r !== null);
  return `${edge.id} (${roles.join(', ')})`;
}

export async function cmdHistory(id: string): Promise<void> {
  const listing = await listHistory(id);
  const state = listing.live ? 'live' : 'DELETED';
  console.log(`${listing.id}  ${state}  ${listing.snapshots.length} snapshot(s)`);
  if (listing.deletion) {
    console.log(`  deleted ${listing.deletion.deletedAt}`);
    if (listing.deletion.edges.length > 0)
      console.log(`  edges stripped from other tickets: ${listing.deletion.edges.map(edgeLabel).join(', ')}`);
  } else if (!listing.live) {
    // Absence of a tombstone is information, not a blank: the id was deleted by a build that
    // predates the record, so the newest snapshot is a pre-delete body, not the final state.
    console.log(`  no ${DELETE_RECORD_FILE} — deleted before delete-time snapshots shipped, so the newest entry may not be its final state`);
  }
  for (const snap of listing.snapshots) {
    const final = listing.deletion?.snapshot === snap.file ? '  (final state at delete)' : '';
    console.log(`  ${snap.file}  ${snap.bytes} B  ${snap.modified}${final}`);
  }
  if (listing.snapshots.length > 0) {
    console.log('\nRestore one with:');
    console.log(listing.live
      ? `  ticket-workflow restore ${listing.id} --at ${listing.snapshots[0].file} [--full]`
      : `  ticket-workflow restore ${listing.id} --undelete`);
  }
}

export interface RestoreArgs {
  readonly id: string
  readonly at: string | null
  readonly full: boolean
  readonly undelete: boolean
}

export function parseRestoreArgs(args: readonly string[]): RestoreArgs {
  let id: string | null = null;
  let at: string | null = null;
  let full = false;
  let undelete = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--at') {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('--at requires a snapshot filename');
      at = v;
    } else if (a === '--full') {
      full = true;
    } else if (a === '--undelete') {
      undelete = true;
    } else if (a.startsWith('-')) {
      // Rejected, not ignored: a typo'd option that silently changes nothing is how a restore
      // quietly does something other than what was asked.
      throw new Error(`unknown option for restore: ${a} (accepts --at <file>, --full, --undelete)`);
    } else if (id === null) {
      id = a;
    } else {
      throw new Error(`restore takes at most one ticket id (got "${id}" and "${a}")`);
    }
  }
  if (id === null) throw new Error('usage: ticket-workflow restore <id> (--at <snapshot> [--full] | --undelete)');
  if (at !== null && undelete) throw new Error('restore takes --at or --undelete, not both');
  if (at === null && !undelete) throw new Error('restore needs --at <snapshot> or --undelete — run `ticket-workflow history <id>` to list snapshots');
  // --full describes which FIELDS of a snapshot to write over a live ticket; an undelete writes the
  // whole file by definition, so accepting it here would advertise a choice that does not exist.
  if (full && undelete) throw new Error('--full does not apply to --undelete, which restores the whole file');
  return { id, at, full, undelete };
}

export async function cmdRestore(args: string[]): Promise<void> {
  const { id, at, full, undelete } = parseRestoreArgs(args);
  if (undelete) {
    const result = await undeleteFromHistory(id);
    console.log(`Recreated ${id} from ${result.from}`);
    console.log(`  ${result.ticket.status ?? 'INVALID STATUS'}  ${result.ticket.title}`);
    if (result.ticket.status === null)
      console.log('  its status is invalid, so it is listed as unreadable — repair it with an update that sets status');
    if (result.edges.length > 0) {
      // Printed, never re-linked: those tickets may have been edited or deleted since.
      console.log(`  re-link by hand if still wanted: ${result.edges.map(edgeLabel).join(', ')}`);
    } else if (!result.tombstone) {
      console.log(`  no ${DELETE_RECORD_FILE} — any blocker/parent edges it once had are unrecorded`);
    }
    return;
  }
  if (at === null) throw new Error('restore needs --at <snapshot> or --undelete');
  const result = await restoreFromSnapshot(id, at, { full });
  console.log(`Restored ${result.scope === 'full' ? 'all fields' : 'the body'} of ${id} from ${result.from}`);
  console.log(`  ${result.ticket.status}  ${result.ticket.title}`);
  console.log('  the pre-restore state was itself snapshotted — `ticket-workflow history` lists it');
}

// The advertised list is GENERATED from the canonical ids, never transcribed (tkt-2b6448a398b9):
// a hand-copied list goes stale in silence when a status is added. `ids` is a parameter rather than
// a direct STATUS_IDS read so a test can inject a list a transcribed literal could not have named —
// asserting only against the real STATUS_IDS cannot tell derived from copied while the copy is correct.
export function statusUsage(ids: readonly string[]): string {
  return `--status requires a valid status (${ids.join('|')})`;
}

export function parseStatus(args: string[]): string | null {
  const i = args.indexOf('--status');
  if (i === -1) return null;
  const value = args[i + 1];
  if (value === undefined || !isStatusId(value)) {
    throw new Error(statusUsage(STATUS_IDS));
  }
  return value;
}

const DOCTOR_FLAGS = ['--strict', '--no-mcp'];

// An unrecognised flag is REJECTED, never ignored. `includes('--strict')` alone means a typo'd
// `--stict` runs non-strict and exits 0 — one character silently disarming the check, which is the
// same shape run-hook.mjs refuses for its fail direction.
export function parseDoctorFlags(args: readonly string[]): { strict: boolean; probeMcp: boolean } {
  const unknown = args.filter((a) => !DOCTOR_FLAGS.includes(a));
  if (unknown.length > 0) {
    throw new Error(`unknown option(s) for doctor: ${unknown.join(', ')} (accepts ${DOCTOR_FLAGS.join(', ')})`);
  }
  return { strict: args.includes('--strict'), probeMcp: !args.includes('--no-mcp') };
}

// Sets process.exitCode rather than throwing: a MISMATCH is a successful diagnosis, and main()'s
// catch prints only an error message — which would hide the report that is the whole output.
// `gather` is injectable so a test can drive a fixture machine instead of the developer's own.
export async function cmdDoctor(args: string[], gather: typeof gatherFacts = gatherFacts): Promise<void> {
  const { strict, probeMcp } = parseDoctorFlags(args);
  const facts = await gather({ probeMcpServer: probeMcp });
  const results = runChecks(facts);
  console.log(formatResults(results));
  const code = exitCodeFor(results, strict);
  if (code !== 0) {
    const failing = results.filter((r) => r.status === 'mismatch' || (strict && r.status === 'unknown'));
    console.log(`\n${failing.length} check(s) need attention${strict ? ' (--strict: UNKNOWN counts)' : ''}.`);
  }
  process.exitCode = code;
}

const AUDIT_FLAGS = ['--json'];

// Same refusal as doctor's flag parsing: an unrecognised option is REJECTED, never ignored — a
// typo'd flag silently changing what a gate command does is how gates rot.
export function parseAuditArgs(args: readonly string[]): { repoDir: string; json: boolean } {
  // Single-dash tokens are rejected too: `-json` silently becoming the PATH would produce a
  // confident all-FAIL report about a directory that does not exist.
  const flags = args.filter((a) => a.startsWith('-'));
  const unknown = flags.filter((a) => !AUDIT_FLAGS.includes(a));
  if (unknown.length > 0) {
    throw new Error(`unknown option(s) for audit: ${unknown.join(', ')} (accepts ${AUDIT_FLAGS.join(', ')})`);
  }
  const positional = args.filter((a) => !a.startsWith('-'));
  if (positional.length !== 1) throw new Error('usage: ticket-workflow audit <path> [--json]');
  return { repoDir: positional[0], json: flags.includes('--json') };
}

// Like cmdDoctor: a FAIL/BLOCKED is a successful diagnosis, so the exit code is set rather than
// thrown — throwing would replace the report with a bare error line. A path that is not a
// directory DOES throw: auditing nothing must be a distinct invocation error, never an all-FAIL
// conformance report about a repo the audit never looked at.
export function cmdAudit(args: string[], stat: (p: string) => { isDirectory(): boolean } = statSync): void {
  const { repoDir, json } = parseAuditArgs(args);
  try {
    if (!stat(repoDir).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`audit target is not a readable directory: ${repoDir}`);
  }
  const report = runAudit(repoDir);
  console.log(json ? JSON.stringify(report, null, 2) : formatAudit(report));
  process.exitCode = auditExitCode(report);
}

/**
 * `vacuous <path>` sweeps and prints candidates as JSON; `--check` ratchets against the repo's own
 * `vacuous-baseline.json`. Usage errors are handled HERE (not thrown) because this subcommand's
 * exit codes are a contract — 1 breach / 2 usage / 3 probe error — and the thrown-error path exits
 * 1, which would make a typo'd flag indistinguishable from a real finding.
 */
export function cmdVacuous(args: string[]): void {
  // A single-dash typo (`-check`) must be a usage error, not a path that fails as exit-3.
  const flags = args.filter((a) => a.startsWith('-'));
  const paths = args.filter((a) => !a.startsWith('-'));
  if (flags.some((f) => f !== '--check') || paths.length !== 1) {
    console.error('usage: ticket-workflow vacuous <path> [--check]');
    process.exitCode = VACUOUS_EXIT.USAGE;
    return;
  }
  if (flags.includes('--check')) {
    const result = checkRoot(paths[0]);
    console.log(result.message);
    process.exitCode = vacuousExitCode(result);
    return;
  }
  try {
    console.log(JSON.stringify(sweep(paths[0]), null, 2));
  } catch (e) {
    // A broken instrument or an empty tree is a probe error, never a clean sweep.
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = VACUOUS_EXIT.PROBE_ERROR;
  }
}

/**
 * `test-slots [status|clear-stale] [--json]` reads or prunes the machine-wide run slots that
 * `holdTestRun` takes (tkt-14788b3fc356). Usage errors exit 2 and unreadable state exits with the
 * helper's own STATE_UNREADABLE code, handled here so a typo is never mistaken for an empty board.
 */
export function cmdTestSlots(args: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  const flags = args.filter((a) => a.startsWith('-'));
  const words = args.filter((a) => !a.startsWith('-'));
  const verb = words[0] ?? 'status';
  if (flags.some((f) => f !== '--json') || words.length > 1 || (verb !== 'status' && verb !== 'clear-stale')) {
    console.error('usage: ticket-workflow test-slots [status|clear-stale] [--json]');
    process.exitCode = 2;
    return;
  }
  const stateDir = testSlotsStateDir(env);
  const opts = { probe: pidLiveness, now: Date.now(), ttlMs: DEFAULT_TTL_MS };
  try {
    const rows = verb === 'status' ? listSlots(stateDir, opts) : clearStaleSlots(stateDir, opts);
    if (flags.includes('--json')) {
      console.log(JSON.stringify({ stateDir, verb, slots: rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log(`${verb === 'status' ? 'no test slots held' : 'no stale test slots'} (${stateDir})`);
      return;
    }
    for (const row of rows) console.log(`${verb === 'status' ? '' : 'removed '}${formatSlot(row)}`);
  } catch (err) {
    if (err instanceof TestRunRefusal) {
      console.error(err.message);
      process.exitCode = err.code;
      return;
    }
    throw err;
  }
}

export function parseInitArgs(args: readonly string[]): { targetDir: string; tier: 'core' | 'node'; force: boolean } {
  const out: { targetDir: string; tier: 'core' | 'node'; force: boolean } = { targetDir: '.', tier: 'node', force: false };
  let sawPath = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force') {
      out.force = true;
    } else if (a === '--tier') {
      const v = args[++i];
      if (v !== 'core' && v !== 'node') throw new Error('--tier requires "core" or "node"');
      out.tier = v;
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option for init: ${a} (accepts --tier <core|node>, --force)`);
    } else if (!sawPath) {
      out.targetDir = a;
      sawPath = true;
    } else {
      throw new Error(`init takes at most one path (got "${out.targetDir}" and "${a}")`);
    }
  }
  return out;
}

export function cmdInit(args: string[], stat: (p: string) => { isDirectory(): boolean } = statSync): void {
  const { targetDir, tier, force } = parseInitArgs(args);
  // A missing leaf is created (initializing a new dir is the headline use), but only under an
  // existing parent, and never over a non-directory: a typo'd deep path silently scaffolded with
  // exit 0 gives no signal that the intended repo was never touched.
  let exists = true;
  try {
    if (!stat(targetDir).isDirectory()) throw new Error('non-directory');
  } catch (err) {
    if (err instanceof Error && err.message === 'non-directory') {
      throw new Error(`init target exists and is not a directory: ${targetDir}`, { cause: err });
    }
    exists = false;
  }
  if (!exists) {
    const parent = path.dirname(path.resolve(targetDir));
    try {
      if (!stat(parent).isDirectory()) throw new Error('bad parent');
    } catch {
      throw new Error(`init target's parent does not exist: ${parent} — check the path for typos`);
    }
    console.log(`created    ${targetDir}`);
  }
  const result = runInit(targetDir, { tier, force });
  for (const f of result.wrote) console.log(`wrote      ${f}`);
  for (const f of result.preserved) console.log(`preserved  ${f}`);
  console.log(`\n${formatAudit(result.report)}`);
  // Not "done" — a fresh scaffold has real work only a human can do; claiming completion here is
  // the fail-open shape one level up.
  console.log('\nRemaining human steps:');
  for (const s of result.humanSteps) console.log(`  - ${s}`);
  process.exitCode = result.exitCode;
}

const VERIFY_FLAGS = ['--all', '--json'];

export function parseVerifyArgs(args: readonly string[]): { id: string | null; all: boolean; json: boolean; project: string | null } {
  const out: { id: string | null; all: boolean; json: boolean; project: string | null } = { id: null, all: false, json: false, project: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--project') {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('--project requires a value');
      out.project = v;
    } else if (VERIFY_FLAGS.includes(a)) {
      if (a === '--all') out.all = true;
      if (a === '--json') out.json = true;
    } else if (a.startsWith('-')) {
      // Unrecognised flags are rejected, not ignored: a typo'd option that silently changes nothing
      // is how a check quietly stops checking what the caller asked for.
      throw new Error(`unknown option for verify: ${a} (accepts ${VERIFY_FLAGS.join(', ')}, --project <name>)`);
    } else if (out.id === null) {
      out.id = a;
    } else {
      throw new Error(`verify takes at most one ticket id (got "${out.id}" and "${a}")`);
    }
  }
  return out;
}

/**
 * REPORT-ONLY, deliberately: exit 0 even with violations.
 *
 * A discrepancy here is a claim the record does not support, which is not the same as proof the work
 * was skipped — the gate may have run under a command the hook does not recognise. Until that rate is
 * known and defensible, failing a build on it would be asserting more than the data carries.
 */
export async function cmdVerify(args: string[], gather = gatherTicketFacts): Promise<void> {
  const { id, all, json, project } = parseVerifyArgs(args);
  const { facts, unreadable } = await gather({ id, project, statuses: all ? null : undefined });
  const report = buildReport(facts);
  if (json) {
    console.log(JSON.stringify({ ...report, boardUnreadable: unreadable }, null, 2));
    return;
  }
  console.log(formatReport(report, unreadable));
}

export interface WorktreeArgs {
  readonly id: string | null;
  readonly branch: string | null;
  readonly base: string | null;
  readonly name: string | null;
  readonly repoDir: string;
}

const WORKTREE_VALUE_FLAGS = ['--branch', '--base', '--name', '--repo'] as const;

export function parseWorktreeArgs(args: readonly string[]): WorktreeArgs {
  const out: { id: string | null; branch: string | null; base: string | null; name: string | null; repoDir: string } = {
    id: null, branch: null, base: null, name: null, repoDir: '.',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--branch' || a === '--base' || a === '--name' || a === '--repo') {
      const v = args[++i];
      if (v === undefined || v.startsWith('-')) throw new Error(`${a} requires a value`);
      if (a === '--branch') out.branch = v;
      else if (a === '--base') out.base = v;
      else if (a === '--name') out.name = v;
      else out.repoDir = v;
    } else if (a.startsWith('-')) {
      // Rejected, never ignored — same reasoning as audit and verify. A typo'd flag that silently
      // does nothing here would cut the branch from the wrong base.
      throw new Error(`unknown option for worktree: ${a} (accepts ${WORKTREE_VALUE_FLAGS.join(', ')})`);
    } else if (out.id === null) {
      out.id = a;
    } else {
      throw new Error(`worktree takes at most one ticket id (got "${out.id}" and "${a}")`);
    }
  }
  if (out.id === null && out.branch === null) {
    throw new Error('usage: ticket-workflow worktree <ticket-id> [--branch <name>] [--base <ref>] [--name <dir>] [--repo <path>]');
  }
  return out;
}

/**
 * Isolate a session in its own worktree, from ANY repo on the machine (`tkt-d330a4b106b9`).
 *
 * The branch name comes from the ticket when the board is reachable, and the command REFUSES with
 * an instruction rather than inventing one when it is not: this package ships to every repo, and
 * the board it resolves depends on where it was run from.
 */
export interface WorktreeDeps {
  readonly fetchTicket: typeof getTicket;
  readonly create: typeof createWorktree;
  readonly provision: typeof provisionWorktree;
}

export async function cmdWorktree(
  args: string[],
  deps: WorktreeDeps = { fetchTicket: getTicket, create: createWorktree, provision: provisionWorktree },
): Promise<void> {
  const { id, branch, base, name, repoDir } = parseWorktreeArgs(args);
  let finalBranch = branch;
  if (finalBranch === null && id !== null) {
    try {
      const t = await deps.fetchTicket(id);
      finalBranch = branchName(PREFIX_BY_TYPE[t.type] ?? 'task', t.id, t.title);
    } catch {
      throw new Error(
        `could not read ticket ${id} from the board reachable from ${repoDir} — pass --branch <name> explicitly`,
      );
    }
  }
  if (finalBranch === null) throw new Error('no branch could be determined');

  const result = deps.create({ repoDir, branch: finalBranch, ...(base ? { base } : {}), ...(name ? { name } : {}) });
  if (result.kind === 'refused') {
    console.error(`refused: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`created    ${result.path}`);
  console.log(`branch     ${result.branch}  (from ${result.base})`);

  // The worktree is kept on a provisioning failure: it is usable once the named file is supplied,
  // and removing it would discard nothing but the evidence of what went wrong.
  const provisioned = deps.provision({ repoDir, worktreeDir: path.resolve(repoDir, result.path) });
  if (provisioned.kind === 'refused') {
    console.error(`provision  refused: ${provisioned.reason}`);
  } else if (!provisioned.declared) {
    console.log('provision  nothing declared (.worktreeinclude, worktree.symlinkDirectories)');
  } else {
    for (const e of provisioned.entries) {
      const line = `provision  ${e.kind.padEnd(8)} ${e.path}${'reason' in e ? `  — ${e.reason}` : ''}`;
      if (e.kind === 'failed') console.error(line);
      else console.log(line);
    }
  }
  if (provisionFailed(provisioned)) process.exitCode = 1;
  console.log('\nNext:');
  console.log(`  cd ${result.path}`);
  console.log('\nWhen the ticket is merged, remove it — a stale worktree carries its own copy of');
  console.log('CLAUDE.md, and stale instructions on disk keep turning up in greps:');
  console.log(`  git worktree remove ${result.path}`);
}

export async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'worktree':
      await cmdWorktree(rest);
      break;
    case 'list':
      await cmdList(parseStatus(rest));
      break;
    case 'doctor':
      await cmdDoctor(rest);
      break;
    case 'audit':
      cmdAudit(rest);
      break;
    case 'init':
      cmdInit(rest);
      break;
    case 'verify':
      await cmdVerify(rest);
      break;
    case 'vacuous':
      cmdVacuous(rest);
      break;
    case 'test-slots':
      cmdTestSlots(rest);
      break;
    case 'test-contention':
      await cmdTestContention(rest);
      break;
    case 'show': {
      const id = rest[0];
      if (id === undefined) throw new Error('usage: ticket-workflow show <id>');
      await cmdShow(id);
      break;
    }
    case 'history': {
      const id = rest[0];
      if (id === undefined) throw new Error('usage: ticket-workflow history <id>');
      await cmdHistory(id);
      break;
    }
    case 'restore':
      await cmdRestore(rest);
      break;
    default:
      console.log(
        'usage: ticket-workflow <list [--status <status>] | show <id> | doctor [--strict] [--no-mcp] | ' +
          'audit <path> [--json] | init [<path>] [--tier <core|node>] [--force] | verify [<id>] [--all] [--project <name>] [--json] | ' +
          'vacuous <path> [--check] | test-slots [status|clear-stale] [--json] | test-contention [--runs <N>] [--control] | ' +
          'history <id> | restore <id> (--at <snapshot> [--full] | --undelete) | ' +
          'worktree <ticket-id> [--branch <name>] [--base <ref>] [--name <dir>] [--repo <path>]>',
      );
      process.exitCode = cmd === undefined ? 0 : 1;
  }
}

type Realpath = (p: string | URL) => string

// Did this module get EXECUTED, or merely imported? Compares realpaths: npm installs `bin` as a
// symlink, so argv[1] is the link while import.meta.url is the resolved target, and a plain href
// comparison makes `npx ticket-workflow …` load this file and exit 0 having run nothing.
// `realpath` is injectable only so the indeterminate branch below is reachable from a test.
export function isMain(
  argv1: string | undefined = process.argv[1],
  realpath: Realpath = realpathSync,
): boolean {
  if (!argv1) return false;
  try {
    return realpath(argv1) === realpath(new URL(import.meta.url));
  } catch (err) {
    // ENOENT is a real answer, not a failure to check: argv[1] names nothing on disk, so it cannot
    // be this module.
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return false;
    // Anything else (EACCES on a parent dir, an installer swapping files mid-run) leaves this
    // undecidable, and here the permissive answer is `false` — the CLI would exit 0 having silently
    // done nothing, which is indistinguishable from success. Run, and say why on stderr.
    console.error(`ticket-workflow: could not resolve ${argv1}; assuming direct execution`);
    return true;
  }
}

if (isMain()) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
