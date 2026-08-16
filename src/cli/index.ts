#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { listTickets, getTicket } from '../server/tickets.js';
import { getTicketEvents } from '../server/events.js';
import { isStatusId, STATUS_IDS } from '../shared/constants.js';
import { runChecks, exitCodeFor, formatResults } from '../doctor/checks.js';
import { gatherFacts } from '../doctor/gather.js';

// Lightweight per-repo board viewer. Resolves the board from the cwd/
// CLAUDE_PROJECT_DIR (see paths.ts), so it shows whichever repo it runs in.
// Renders the pipeline from the SAME reducePipeline the web board uses, so the
// text view can't drift from the real tracker.

const GLYPH: Record<string, string> = {
  passed: '✓',
  reached: '✓',
  failed: '✗',
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
    const glyph = GLYPH[step.state] ?? '·';
    const when = step.at ? `  (${step.at})` : '';
    console.log(`  ${glyph} ${step.label}${when}`);
  }
  // Without this the pipeline above renders a discarded event as a never-run step — the exact
  // ambiguity the counts exist to remove. Returning them from readEvents does NOT force a caller
  // to look: destructuring drops them and typecheck stays clean, which is how this was missed.
  if (skipped > 0) console.log(`  ! ${skipped} unreadable line(s) — steps above may be incomplete`);
  if (unrecognized > 0) console.log(`  ! ${unrecognized} line(s) written by a newer ticket-workflow`);
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

export async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'list':
      await cmdList(parseStatus(rest));
      break;
    case 'doctor':
      await cmdDoctor(rest);
      break;
    case 'show': {
      const id = rest[0];
      if (id === undefined) throw new Error('usage: ticket-workflow show <id>');
      await cmdShow(id);
      break;
    }
    default:
      console.log('usage: ticket-workflow <list [--status <status>] | show <id> | doctor [--strict] [--no-mcp]>');
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
