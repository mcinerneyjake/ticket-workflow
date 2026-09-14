import fs from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleToolCall } from './handlers.js';
import { archiveStaleTickets, createTicket, updateTicket } from '../server/tickets.js';
import { setLogger } from '../logger.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';

// stdout is the stdio MCP server's JSON-RPC framing channel, so a single non-protocol line written
// anywhere under it desynchronises the session. These two suites guard that from both ends: the
// static one covers the whole reachable graph including code no tool calls today, the runtime one
// covers what actually executes (tkt-c2ed32531824).

const SRC = fileURLToPath(new URL('..', import.meta.url));

// TWO entry points, because the package's principal consumer does not load the one you would
// expect: kanban's .mcp.json runs its OWN mcp/server.ts, whose handlers re-export from
// 'ticket-workflow' — the barrel. So the live stdio process loads index.ts's graph (audit/, init/,
// vacuous/, templates), not just mcp/server.ts's eight modules. Guarding only the latter would
// leave the modules actually in the server process unchecked.
const ENTRIES = [path.join(SRC, 'mcp', 'server.ts'), path.join(SRC, 'index.ts')];

// Bare `import './x.js'` and `await import('./x.js')` carry no `from`, so a `from`-only pattern
// enqueues neither while still reporting a pass — a module with a live console.log reachable by a
// side-effect import stayed green under exactly that hole.
const SPECIFIER_RE = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g;

// readFileSync is left to throw on a specifier this resolver cannot follow: silently skipping one
// would shrink the scanned set while still reporting a pass, which is the fail-open this test
// exists to close. Third-party code is out of scope by construction — a dependency printing to
// stdout desynchronises the protocol identically and neither half of this guard can see it.
function reachableFrom(entries: string[]): Map<string, string> {
  const sources = new Map<string, string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || sources.has(file)) continue;
    const src = readFileSync(file, 'utf8');
    sources.set(file, src);
    for (const [, spec] of src.matchAll(SPECIFIER_RE)) {
      if (!spec.startsWith('.')) continue; // bare specifier — node_modules, not ours to scan
      queue.push(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  }
  return sources;
}

describe('no console reaches the MCP entry point', () => {
  const graph = reachableFrom(ENTRIES);
  const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');
  const files = [...graph.keys()].map(rel);

  // Control. Without this the suite passes just as well on an empty graph — a resolver change or a
  // moved entry point would report "no console found" having scanned nothing. The audit/init
  // entries are here because they arrive only through the barrel: if this list ever shrinks back to
  // the mcp/server.ts eight, the second entry point has silently stopped being walked.
  it('reached every module that carries the risk', () => {
    expect(files).toEqual(expect.arrayContaining([
      'mcp/server.ts',
      'mcp/handlers.ts',
      'server/tickets.ts',
      'server/events.ts',
      'server/validation.ts',
      'paths.ts',
      'logger.ts',
      'shared/constants.ts',
      'index.ts',
      'audit/run.ts',
      'init/run.ts',
      'templates.ts',
    ]));
  });

  // Negative control, in two halves: the walk must EXCLUDE the CLI, and the CLI must really contain
  // the thing being hunted. The second half is what keeps the first from being vacuous — it proves a
  // bare console.log in this tree is detectable by the matcher below, so the exclusion is a real
  // discrimination rather than a matcher that finds nothing anywhere.
  it('does not reach the CLI, whose stdout IS its output channel', () => {
    expect(files).not.toContain('cli/index.ts');
    expect(readFileSync(path.join(SRC, 'cli', 'index.ts'), 'utf8')).toContain('console.log');
  });

  // `process.stdout` is matched alongside console because logger.ts makes `process.stderr.write` the
  // house idiom, and the two differ by one character — a direct stdout write is the likeliest way
  // this invariant actually breaks, and a console-only matcher passes straight over it. No exception
  // is needed for logger.ts: it writes to stderr only.
  //
  // Comments are deliberately NOT stripped before matching. A comment that merely mentions the
  // literal token will fail this test, which is the harmless direction: the fix is to reword it.
  // Stripping comments adds a parser whose own bugs fail the other way — quietly hiding a real call.
  it.each(['console.', 'process.stdout'])('contains no %s anywhere in the graph', (needle) => {
    const offenders: string[] = [];
    for (const [file, src] of graph) {
      src.split('\n').forEach((line, i) => {
        if (line.includes(needle)) offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, 'Use `log` from src/logger.ts — every level of it writes to stderr').toEqual([]);
  });
});

describe('nothing executed under the MCP server writes to stdout', () => {
  const dirs = setupTempTicketDirs('tw-stdout-silence');

  afterEach(() => {
    vi.restoreAllMocks();
    setLogger(null);
  });

  // Captures at the stream, not at `console`: a call that bypassed console entirely would be
  // invisible to a console spy, and bypassing console is exactly what logger.ts does.
  function captureStdout(): string[] {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    return chunks;
  }

  it('stays silent across a full tool sequence, success and error paths alike', async () => {
    const created = await createTicket({ title: 'stdout probe', type: 'task' });
    const stdout = captureStdout();

    await handleToolCall('list_tickets', {});
    await handleToolCall('get_ticket', { id: created.id });
    await handleToolCall('start_ticket', { id: created.id });
    await handleToolCall('update_ticket', { id: created.id, priority: 'high' });
    await handleToolCall('record_review', { id: created.id });
    await handleToolCall('archive_ticket', { id: created.id });
    await handleToolCall('delete_ticket', { id: created.id });
    await handleToolCall('get_ticket', { id: 'tkt-doesnotexist' }); // HttpError path
    await handleToolCall('no_such_tool', {}); // unknown-tool path

    expect(stdout.join('')).toBe('');
  });

  // The sequence above drives no log call at all: both its error paths return an HttpError and exit
  // handleToolCall's catch BEFORE the log.error, so the one handler line that logs went unmeasured
  // and the assertion held over a path that never logged. A non-HttpError fault is what reaches it.
  it('stays silent on the catch-all path that actually logs', async () => {
    const created = await createTicket({ title: 'eacces probe', type: 'task' });
    const err: NodeJS.ErrnoException = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    vi.spyOn(fs, 'readFile').mockRejectedValue(err);

    const logged: string[] = [];
    setLogger({ info: () => undefined, warn: () => undefined, error: (...a) => { logged.push(a.map(String).join(' ')); } });
    const stdout = captureStdout();

    const res = await handleToolCall('get_ticket', { id: created.id });

    expect(res.isError).toBe(true);
    expect(logged.join(' ')).toContain('[mcp] tool call failed'); // the logging line really ran
    expect(stdout.join('')).toBe('');
  });

  // archiveStaleTickets is the reason this ticket exists: no MCP tool calls it, so the suite above
  // would stay green with its log back on stdout. It is a public export one import away from the
  // server, which is why its channel is pinned directly.
  it('keeps archiveStaleTickets off stdout and on stderr', async () => {
    const stale = await createTicket({ title: 'stale', type: 'task' });
    await updateTicket(stale.id, { status: 'done' });
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const file = path.join(dirs.tickets, `${stale.id}.md`);
    const raw = readFileSync(file, 'utf8');
    writeFileSync(file, raw.replace(/^updated: .*$/m, `updated: ${old}`));

    // The DEFAULT sink is restored (the global setup silences) and the real stream is spied, so this
    // observes the actual channel. Capturing through an injected logger instead would only prove the
    // message reached log.info — naming the destination without ever watching it.
    setLogger(null);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { stderr.push(String(c)); return true; });
    const stdout = captureStdout();

    const count = await archiveStaleTickets();

    expect(count).toBe(1);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('[archive] Archived 1 stale ticket(s)');
  });
});
