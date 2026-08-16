import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStatus, statusUsage, cmdList, cmdShow, cmdDoctor, parseDoctorFlags, parseAuditArgs, cmdAudit, cmdVerify, parseVerifyArgs, main, isMain } from './index.js';
import { createTicket, HttpError } from '../server/tickets.js';
import { appendEvent, getTicketEvents } from '../server/events.js';
import { STATUS_IDS } from '../shared/constants.js';
import type { DoctorFacts } from '../doctor/checks.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';

// Wrapped (not stubbed) so cmdShow's ordering is observable: the real implementation still runs.
vi.mock('../server/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/events.js')>();
  return { ...actual, getTicketEvents: vi.fn(actual.getTicketEvents) };
});

const dirs = setupTempTicketDirs('tw-cli-test');

// Seed a raw events file directly, bypassing appendEvent's validation — the only way to stage a
// corrupt log, since appendEvent cannot produce one.
async function writeRawEvents(ticketId: string, lines: string[]) {
  await fs.writeFile(path.join(dirs.events, `${ticketId}.jsonl`), lines.join('\n'), 'utf8');
}

// Restored individually rather than via restoreAllMocks, which would strip the getTicketEvents
// wrapper above and leave the happy-path test asserting against undefined.
let logSpy: { mockRestore: () => void } | null = null;

function captureLog() {
  const lines: string[] = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  });
  return lines;
}

afterEach(() => {
  logSpy?.mockRestore();
  logSpy = null;
});

// main() reads process.argv directly and writes process.exitCode; both are restored, or a stray
// exitCode from a test would fail the whole vitest run for reasons nothing reports.
// `return await`, not `return`: without it the finally block restores argv/exitCode as soon as fn
// SUSPENDS, so anything the callback asserts after its first await reads the already-restored value.
async function withArgv<T>(args: string[], fn: () => Promise<T>): Promise<T> {
  const savedArgv = process.argv;
  const savedExit = process.exitCode;
  process.argv = [savedArgv[0] ?? 'node', 'ticket-workflow', ...args];
  try {
    return await fn();
  } finally {
    process.argv = savedArgv;
    process.exitCode = savedExit;
  }
}

describe('statusUsage', () => {
  // The load-bearing test for tkt-2b6448a398b9. Asserting the real message against the real
  // STATUS_IDS passes just as happily when the list is hand-copied, because the copy is currently
  // correct — so it proves nothing until a seventh status exists. An INJECTED list cannot be
  // transcribed in advance: a literal implementation fails this today.
  it('names exactly the ids it is given — a transcribed list cannot', () => {
    expect(statusUsage(['alpha', 'beta'])).toContain('alpha');
    expect(statusUsage(['alpha', 'beta'])).toContain('beta');
    expect(statusUsage(['alpha', 'beta'])).not.toContain('backlog');
  });

  it('separates ids with | inside the parenthetical', () => {
    expect(statusUsage(['a', 'b', 'c'])).toBe('--status requires a valid status (a|b|c)');
  });
});

describe('parseStatus', () => {
  it('returns null when --status is absent', () => {
    expect(parseStatus([])).toBeNull();
    expect(parseStatus(['list'])).toBeNull();
  });

  it('accepts every canonical status id', () => {
    for (const id of STATUS_IDS) expect(parseStatus(['--status', id])).toBe(id);
  });

  it('rejects an unknown status', () => {
    expect(() => parseStatus(['--status', 'shipped'])).toThrow(/--status requires a valid status/);
  });

  it('rejects a trailing --status with no value', () => {
    expect(() => parseStatus(['--status'])).toThrow(/--status requires a valid status/);
  });

  // Binds the thrown message to the generator, so parseStatus cannot quietly grow its own copy.
  // Residual, stated plainly: a literal identical to the generated string still satisfies this
  // today — statusUsage's injected-list test above is what actually pins the derivation.
  it('throws exactly the generated usage for the canonical ids', () => {
    const message = (() => {
      try {
        parseStatus(['--status', 'not-a-status']);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      throw new Error('expected parseStatus to reject');
    })();
    expect(message).toBe(statusUsage(STATUS_IDS));
    for (const id of STATUS_IDS) expect(message).toContain(id);
  });
});

describe('cmdShow', () => {
  it('rejects an unknown id without ever reading its events', async () => {
    const lines = captureLog();
    const before = vi.mocked(getTicketEvents).mock.calls.length;
    const err: unknown = await cmdShow('tkt-doesnotexist').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    if (!(err instanceof HttpError)) throw new Error('expected HttpError');
    expect(err.status).toBe(404);
    expect(lines).toEqual([]);
    // The getTicket-before-getTicketEvents ordering is the point, not incidental: events for a
    // typo'd id reduce to an all-pending pipeline indistinguishable from a real un-started ticket.
    // Swapping the two calls turns this red; a 404-only assertion stays green either way.
    expect(vi.mocked(getTicketEvents).mock.calls.length).toBe(before);
  });

  // Review finding on tkt-355581f9dab3: returning the counts from readEvents does NOT force a
  // caller to look at them — cmdShow destructured only `pipeline` and typecheck stayed clean while
  // it rendered a damaged log as a normal one. These pin the only channel that reports the loss here.
  it('warns when events were lost, so a discarded step is not read as a step never run', async () => {
    const t = await createTicket({ title: 'Damaged', type: 'chore', priority: 'low', status: 'todo' });
    await writeRawEvents(t.id, [
      'not json at all',
      JSON.stringify({ ticketId: t.id, step: 'lint', state: 'passed', at: '2026-07-01T00:00:00.000Z' }),
      JSON.stringify({ ticketId: t.id, step: 'commit', state: 'passed' }), // missing `at`
      '', // force a trailing newline so no line is treated as mid-write
    ]);
    const lines = captureLog();
    await cmdShow(t.id);
    expect(lines.some((l) => l.includes('! 2 unreadable line(s)'))).toBe(true);
  });

  it('distinguishes a newer writer from data loss', async () => {
    const t = await createTicket({ title: 'Skewed', type: 'chore', priority: 'low', status: 'todo' });
    await writeRawEvents(t.id, [
      JSON.stringify({ ticketId: t.id, step: 'lint', state: 'passed', at: '2026-07-01T00:00:00.000Z' }),
      JSON.stringify({ ticketId: t.id, step: 'deploy', state: 'passed', at: 'x' }), // future step id
      '',
    ]);
    const lines = captureLog();
    await cmdShow(t.id);
    expect(lines.some((l) => l.includes('written by a newer ticket-workflow'))).toBe(true);
    expect(lines.some((l) => l.includes('unreadable line(s)'))).toBe(false); // skew is not loss
  });

  it('stays quiet on a clean log — a warning on every show would train the reader to ignore it', async () => {
    const t = await createTicket({ title: 'Clean', type: 'chore', priority: 'low', status: 'todo' });
    await appendEvent({ ticketId: t.id, step: 'lint', state: 'passed' });
    const lines = captureLog();
    await cmdShow(t.id);
    expect(lines.some((l) => l.includes('!'))).toBe(false);
  });

  it('prints the ticket header and one line per pipeline step', async () => {
    const t = await createTicket({ title: 'CLI show fixture', type: 'chore', priority: 'low', status: 'todo' });
    await appendEvent({ ticketId: t.id, step: 'typecheck', state: 'passed', at: '2026-07-01T00:00:00.000Z' });
    const lines = captureLog();
    await cmdShow(t.id);
    expect(lines[0]).toBe(`${t.id}  todo  CLI show fixture`);
    expect(lines.some((l) => l.includes('✓') && l.includes('2026-07-01T00:00:00.000Z'))).toBe(true);
    expect(lines.some((l) => l.startsWith('  ·'))).toBe(true); // steps with no event stay pending
  });
});

describe('cmdList', () => {
  it('prints "No tickets." on an empty board', async () => {
    const lines = captureLog();
    await cmdList(null);
    expect(lines).toEqual(['No tickets.']);
  });

  it('filters by status, and reports an empty match as no tickets rather than listing all', async () => {
    await createTicket({ title: 'A backlog one', type: 'chore', priority: 'low', status: 'backlog' });
    await createTicket({ title: 'A todo one', type: 'chore', priority: 'low', status: 'todo' });

    const all = captureLog();
    await cmdList(null);
    expect(all).toHaveLength(2);
    logSpy?.mockRestore();

    const filtered = captureLog();
    await cmdList('todo');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toContain('A todo one');
    logSpy?.mockRestore();

    const none = captureLog();
    await cmdList('done');
    expect(none).toEqual(['No tickets.']);
  });
});

// A wholly healthy machine, stated in full so no field can default to the passing answer.
const ALL_OK_FACTS: DoctorFacts = {
  postToolUse: [{ command: 'track-steps.sh', kind: 'writer' }],
  guardCopies: [],
  canonicalShas: {},
  installs: [{ root: '/tools', version: '9.9.9' }],
  selfVersion: '9.9.9',
  mcp: { probed: true, configured: true, resolved: true, version: '9.9.9' },
  board: { root: '/b', via: 'writer wiring', ticketsDir: '/b/tickets', ticketsDirExists: true, targets: [{ source: 'w', root: '/b' }] },
  protectedBranch: { current: 'feat/x', protects: ['main'], existing: ['main'], hasRemote: true },
  lastHookEventAt: '2026-08-16T00:00:00.000Z',
  now: '2026-08-16T01:00:00.000Z',
  gateScripts: { r: ['typecheck', 'lint', 'test'] },
};

describe('main', () => {
  it('exits 0 on a bare invocation but 1 on an unknown subcommand', async () => {
    const bare = captureLog();
    await withArgv([], async () => {
      await main();
      expect(process.exitCode).toBe(0);
    });
    expect(bare[0]).toContain('usage:');
    logSpy?.mockRestore();

    captureLog();
    await withArgv(['frobnicate'], async () => {
      await main();
      expect(process.exitCode).toBe(1);
    });
  });

  it('rejects `show` with no id', async () => {
    captureLog();
    await withArgv(['show'], async () => {
      await expect(main()).rejects.toThrow(/usage: ticket-workflow show <id>/);
    });
  });

  it('advertises doctor, so the command is discoverable from the usage line', async () => {
    const bare = captureLog();
    await withArgv([], async () => {
      await main();
    });
    expect(bare[0]).toContain('doctor');
  });

  it('routes `doctor` and sets an exit CODE rather than throwing', async () => {
    // main()'s catch prints only an error message, so a check that threw would replace the report
    // with one line — and a MISMATCH is a successful diagnosis, not a crash.
    //
    // Facts are INJECTED. Running the real gatherFacts made this read the developer's own
    // ~/.claude — so what it exercised varied per machine, and asserting `[0, 2]` accepted every
    // value exitCodeFor can return, i.e. the assertion could not fail.
    const lines = captureLog();
    await withArgv(['doctor', '--no-mcp'], async () => {
      await cmdDoctor(['--no-mcp'], async () => ALL_OK_FACTS);
      expect(process.exitCode).toBe(0);
    });
    expect(lines.join('\n')).toContain('OK        writer-uniqueness');
  });

  it('exits 2 when a check MISMATCHes, on the same injected facts', async () => {
    captureLog();
    await withArgv(['doctor'], async () => {
      await cmdDoctor([], async () => ({
        ...ALL_OK_FACTS,
        postToolUse: [
          { command: 'a', kind: 'writer' as const },
          { command: 'b', kind: 'writer' as const },
        ],
      }));
      expect(process.exitCode).toBe(2);
    });
  });

  it('REJECTS an unknown doctor flag instead of quietly running without it', async () => {
    // `--stict` used to run non-strict and exit 0 — one character disarming the check, the same
    // shape run-hook.mjs refuses for its fail direction.
    expect(() => parseDoctorFlags(['--stict'])).toThrow(/unknown option/);
    expect(() => parseDoctorFlags(['--strict=true'])).toThrow(/unknown option/);
    expect(parseDoctorFlags(['--strict', '--no-mcp'])).toEqual({ strict: true, probeMcp: false });
  });

  it('advertises verify in the usage line', async () => {
    const bare = captureLog();
    await withArgv([], async () => { await main(); });
    expect(bare[0]).toContain('verify');
  });

  it('main() ROUTES verify — renaming the case must not stay green', async () => {
    // The previous test of this name only read the usage string: renaming `case 'verify'` left all
    // 31 CLI tests green while the real command printed usage and exited 1. This drives main()
    // against the temp board, so only actual routing satisfies it.
    await createTicket({ title: 'Routed to verify', type: 'chore', priority: 'low', status: 'done' });
    const lines = captureLog();
    await withArgv(['verify'], async () => {
      await main();
      expect(process.exitCode).toBeUndefined(); // routed AND report-only
    });
    const out = lines.join('\n');
    expect(out).toContain('could NOT be judged');
    expect(out).not.toContain('usage:');
  });

  it('parses verify arguments, and REJECTS what it does not recognise', () => {
    expect(parseVerifyArgs([])).toEqual({ id: null, all: false, json: false, project: null });
    expect(parseVerifyArgs(['tkt-1', '--all', '--json', '--project', 'kanban'])).toEqual({
      id: 'tkt-1', all: true, json: true, project: 'kanban',
    });
    expect(() => parseVerifyArgs(['--al'])).toThrow(/unknown option/);
    expect(() => parseVerifyArgs(['--project'])).toThrow(/requires a value/);
    // A flag swallowed as the project name would filter to a project nothing matches, and report a
    // confident empty result rather than an error.
    expect(() => parseVerifyArgs(['--project', '--json'])).toThrow(/requires a value/);
    expect(() => parseVerifyArgs(['tkt-1', 'tkt-2'])).toThrow(/at most one ticket id/);
  });

  it('verify is REPORT-ONLY — a violation must not set a failing exit code', async () => {
    // The plan is explicit that this must not emit a build-failing verdict until the discrepancy
    // rate is defensible. Facts are injected so the assertion does not depend on the real board.
    const lines = captureLog();
    await withArgv(['verify'], async () => {
      await cmdVerify([], async () => ({
        facts: [{
          id: 'tkt-x', title: 'T', status: 'done', steps: { branch: 'passed' },
          skippedLines: 0, unrecognizedLines: 0, unreadableLog: false,
          claim: { kind: 'added' as const, text: '3 added — x' },
        }],
        unreadable: 0,
      }));
      expect(process.exitCode).toBeUndefined();
    });
    expect(lines.join('\n')).toContain('VIOLATIONS');
  });

  it('verify --json emits the counts as data, including the unparseable-file count', async () => {
    const lines = captureLog();
    await withArgv(['verify'], async () => {
      await cmdVerify(['--json'], async () => ({ facts: [], unreadable: 2 }));
    });
    const parsed: unknown = JSON.parse(lines.join(''));
    expect(parsed).toMatchObject({ considered: 0, unknown: 0, boardUnreadable: 2 });
  });

  it('routes `list --status` through parseStatus', async () => {
    await createTicket({ title: 'Routed', type: 'chore', priority: 'low', status: 'todo' });
    const lines = captureLog();
    await withArgv(['list', '--status', 'todo'], async () => {
      await main();
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Routed');
  });
});

describe('parseAuditArgs', () => {
  it('takes one path and the --json flag', () => {
    expect(parseAuditArgs(['/some/repo'])).toEqual({ repoDir: '/some/repo', json: false });
    expect(parseAuditArgs(['/some/repo', '--json'])).toEqual({ repoDir: '/some/repo', json: true });
  });

  it('rejects an unknown flag instead of ignoring it — a typo must not change what a gate runs', () => {
    expect(() => parseAuditArgs(['/some/repo', '--jsom'])).toThrow(/unknown option/);
    // Single-dash too: '-json' silently becoming the PATH would audit a directory that does not
    // exist and report confident all-FAIL conformance about it.
    expect(() => parseAuditArgs(['/some/repo', '-json'])).toThrow(/unknown option/);
  });

  it('rejects zero and multiple paths', () => {
    expect(() => parseAuditArgs([])).toThrow(/usage/);
    expect(() => parseAuditArgs(['/a', '/b'])).toThrow(/usage/);
  });

  it('cmdAudit refuses a non-directory target instead of reporting it non-conformant', () => {
    expect(() => cmdAudit(['/definitely/not/a/real/dir'])).toThrow(/not a readable directory/);
  });
});

describe('isMain', () => {
  const self = fileURLToPath(new URL('./index.ts', import.meta.url));

  it('is true through a symlink — npm installs `bin` as one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-cli-bin-'));
    const link = path.join(dir, 'ticket-workflow');
    try {
      await fs.symlink(self, link);
      // A plain argv[1]-vs-import.meta.url href comparison returns false here, and the CLI would
      // exit 0 having run nothing.
      expect(isMain(link)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('is true for the module path itself', () => {
    expect(isMain(self)).toBe(true);
  });

  // The real negative control: an EXISTING file, so the realpath comparison actually runs. A
  // nonexistent path only reaches the ENOENT branch and would leave `realpath(x) === realpath(x)`
  // style mutations uncaught.
  it('is false for a different file that exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-cli-other-'));
    const other = path.join(dir, 'other-entrypoint.mjs');
    try {
      await fs.writeFile(other, '// not the CLI\n', 'utf8');
      expect(isMain(other)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('is false for a path that does not exist (ENOENT is an answer, not a failure to check)', () => {
    expect(isMain(path.join(os.tmpdir(), 'tw-definitely-absent-9f3a.mjs'))).toBe(false);
  });

  // Stubs process.argv rather than passing `undefined`: an explicit undefined triggers the default
  // initializer and silently tests process.argv[1] instead of the empty-argv branch.
  it('is false when there is no argv[1] at all', () => {
    const saved = process.argv;
    try {
      process.argv = [saved[0] ?? 'node'];
      expect(isMain()).toBe(false);
    } finally {
      process.argv = saved;
    }
  });

  it('runs, loudly, when realpath cannot decide — silence would exit 0 having done nothing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const eacces = () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      };
      expect(isMain('/some/unreadable/bin/ticket-workflow', eacces)).toBe(true);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('could not resolve'));
    } finally {
      errSpy.mockRestore();
    }
  });
});
