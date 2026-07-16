#!/usr/bin/env node
import { listTickets, getTicket } from '../server/tickets.js';
import { getTicketEvents } from '../server/events.js';
import { isStatusId } from '../shared/constants.js';

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

async function cmdList(statusFilter: string | null): Promise<void> {
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

async function cmdShow(id: string): Promise<void> {
  // Verify the ticket exists first — getTicket throws HttpError(404) for a missing
  // id (caught in main → exit 1). Without this, getTicketEvents on a typo'd/deleted
  // id returns an all-pending pipeline, indistinguishable from a real un-started one.
  const ticket = await getTicket(id);
  const { pipeline } = await getTicketEvents(id);
  console.log(`${ticket.id}  ${ticket.status}  ${ticket.title}`);
  for (const step of pipeline) {
    const glyph = GLYPH[step.state] ?? '·';
    const when = step.at ? `  (${step.at})` : '';
    console.log(`  ${glyph} ${step.label}${when}`);
  }
}

function parseStatus(args: string[]): string | null {
  const i = args.indexOf('--status');
  if (i === -1) return null;
  const value = args[i + 1];
  if (value === undefined || !isStatusId(value)) {
    throw new Error('--status requires a valid status (backlog|todo|in-progress|qa|done|archived)');
  }
  return value;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'list':
      await cmdList(parseStatus(rest));
      break;
    case 'show': {
      const id = rest[0];
      if (id === undefined) throw new Error('usage: ticket-workflow show <id>');
      await cmdShow(id);
      break;
    }
    default:
      console.log('usage: ticket-workflow <list [--status <status>] | show <id>>');
      process.exitCode = cmd === undefined ? 0 : 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
