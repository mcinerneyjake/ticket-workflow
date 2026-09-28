import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyGateBoard, childEnv, GATE_BOARD_ENV, GATE_EXIT, gitLocalEnvVars, parseTestCounts, readScripts,
  resolveRecording, runGate, spawnScript, ticketIdFromBranch,
  type Append, type GateStep, type Recording, type ScriptRun,
} from './run.js';
import { cmdGate } from '../cli/index.js';
import { createTicket } from '../server/tickets.js';
import { readEvents } from '../server/events.js';
import { gatherTicketFacts } from '../verify/gather.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';

const dirs = setupTempTicketDirs('tw-gate-test');
const ID = 'tkt-0123456789ab';
const ALL = new Set(['typecheck', 'lint', 'test']);
const RECORD: Recording = { kind: 'record', ticketId: ID };

function runner(results: Partial<Record<GateStep, Partial<ScriptRun>>>) {
  const calls: GateStep[] = [];
  const run = async (step: GateStep): Promise<ScriptRun> => {
    calls.push(step);
    return { exitCode: 0, summaries: [], durationMs: 1000, ...results[step] };
  };
  return { run, calls };
}

function collect() {
  const lines: string[] = [];
  return { lines, print: (l: string) => { lines.push(l); } };
}

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('parseTestCounts', () => {
  it('reads a vitest summary, folding todo into skipped and expected fail into passed', () => {
    expect(parseTestCounts([' Test Files  1 failed | 40 passed (41)', '      Tests  3 failed | 2854 passed | 1 expected fail | 2 skipped | 1 todo (2861)']))
      .toEqual({ passed: 2855, failed: 3, skipped: 3 });
  });

  it('ignores ANSI colour codes', () => {
    expect(parseTestCounts(['\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m12 passed\u001b[39m\u001b[22m\u001b[90m (12)\u001b[39m']))
      .toEqual({ passed: 12, failed: 0, skipped: 0 });
  });

  it('sums every summary a chained script prints', () => {
    expect(parseTestCounts(['      Tests  5 passed (5)', '      Tests  1 failed | 2 passed (3)']))
      .toEqual({ passed: 7, failed: 1, skipped: 0 });
  });

  it('returns null, not zeros, when no summary was printed', () => {
    expect(parseTestCounts([' Test Files  4 passed (4)', '# pass 4'])).toBeNull();
    expect(parseTestCounts([])).toBeNull();
  });

  it('rejects a Tests-shaped line it does not understand instead of counting zeros', () => {
    expect(parseTestCounts(['   Tests for the parser (2)'])).toBeNull();
    expect(parseTestCounts(['      Tests  2 passed | 1 flaky (3)'])).toBeNull();
    expect(parseTestCounts(['      Tests  2 passed (3)'])).toBeNull(); // parts disagree with the total
  });
});

describe('childEnv', () => {
  it('drops git repo context and every board variable, CLAUDE_PROJECT_DIR included, keeping everything else', () => {
    const env = childEnv(
      { GIT_DIR: '/x/.git', GIT_CONFIG_PARAMETERS: "'core.hooksPath'='x'", GIT_AUTHOR_NAME: 'a', PATH: '/bin', CLAUDE_PROJECT_DIR: '/p',
        BOARD_DIR_OVERRIDE: '/b', TICKETS_DIR_OVERRIDE: '/t', EVENTS_DIR_OVERRIDE: '/e', [GATE_BOARD_ENV]: '/g' },
      ['GIT_DIR', 'GIT_CONFIG_PARAMETERS'],
    );
    expect(env).toEqual({ GIT_AUTHOR_NAME: 'a', PATH: '/bin' });
  });

  it("asks git for its repo-local variables, covering ones a hand-kept list missed", () => {
    expect(gitLocalEnvVars()).toEqual(expect.arrayContaining(['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_COMMON_DIR']));
  });
});

describe('applyGateBoard', () => {
  it('points this process at the gate-only board var, and is a no-op without it', () => {
    const env: NodeJS.ProcessEnv = { [GATE_BOARD_ENV]: '/central' };
    applyGateBoard(env);
    expect(env.BOARD_DIR_OVERRIDE).toBe('/central');
    const bare: NodeJS.ProcessEnv = { BOARD_DIR_OVERRIDE: '/mine' };
    applyGateBoard(bare);
    expect(bare.BOARD_DIR_OVERRIDE).toBe('/mine');
  });
});

describe('ticketIdFromBranch', () => {
  it('reads one bounded id, and refuses a longer hex run or two different ids', () => {
    expect(ticketIdFromBranch(`feat/${ID}-slug`)).toBe(ID);
    expect(ticketIdFromBranch(`fix/${ID}-followup-${ID}`)).toBe(ID);
    expect(ticketIdFromBranch('feat/tkt-0123456789abc-x')).toBeNull();
    expect(ticketIdFromBranch(`fix/${ID}-followup-tkt-bbbbbbbbbbbb`)).toBeNull();
    expect(ticketIdFromBranch('main')).toBeNull();
  });
});

// Every case restores the env it touches; resolveRecording reads it live.
function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

describe('resolveRecording', () => {
  it('skips when the branch could not be read', async () => {
    expect(await resolveRecording(null)).toEqual({ kind: 'skip', reason: 'could not read the current branch' });
  });

  it('skips a branch naming no single ticket', async () => {
    expect((await resolveRecording('main')).kind).toBe('skip');
    expect((await resolveRecording('HEAD')).kind).toBe('skip');
  });

  it('skips, naming the board it looked in, when the ticket is not on it', async () => {
    const r = await resolveRecording(`feat/${ID}-x`);
    expect(r).toMatchObject({ kind: 'skip' });
    expect(r.kind === 'skip' && r.reason).toContain(dirs.tickets);
  });

  it('records when the board holds the ticket', async () => {
    await fs.writeFile(path.join(dirs.tickets, `${ID}.md`), '---\n---\n');
    expect(await resolveRecording(`feat/${ID}-x`)).toEqual(RECORD);
  });

  it('errors, rather than skipping, when the ticket path exists but is not a file', async () => {
    await fs.mkdir(path.join(dirs.tickets, `${ID}.md`));
    expect((await resolveRecording(`feat/${ID}-x`)).kind).toBe('error');
  });

  it('errors when only one of the tickets/events overrides is set, since check and write would split', async () => {
    await fs.writeFile(path.join(dirs.tickets, `${ID}.md`), '---\n---\n');
    await withEnv({ EVENTS_DIR_OVERRIDE: undefined }, async () => {
      const r = await resolveRecording(`feat/${ID}-x`);
      expect(r.kind === 'error' && r.reason).toContain('only one of TICKETS_DIR_OVERRIDE and EVENTS_DIR_OVERRIDE');
    });
  });

  it('errors when the gate-only board var would be outranked by the overrides', async () => {
    await fs.writeFile(path.join(dirs.tickets, `${ID}.md`), '---\n---\n');
    await withEnv({ [GATE_BOARD_ENV]: '/central' }, async () => {
      expect((await resolveRecording(`feat/${ID}-x`)).kind).toBe('error');
    });
  });

  it('errors when a configured board has no tickets directory, or a file in its place', async () => {
    const root = await tempDir('tw-gate-typo-');
    await withEnv({ TICKETS_DIR_OVERRIDE: undefined, EVENTS_DIR_OVERRIDE: undefined, [GATE_BOARD_ENV]: undefined, BOARD_DIR_OVERRIDE: path.join(root, 'typo') }, async () => {
      expect((await resolveRecording(`feat/${ID}-x`)).kind).toBe('error');
    });
    await fs.writeFile(path.join(root, 'tickets'), '');
    await withEnv({ TICKETS_DIR_OVERRIDE: undefined, EVENTS_DIR_OVERRIDE: undefined, [GATE_BOARD_ENV]: undefined, BOARD_DIR_OVERRIDE: root }, async () => {
      expect((await resolveRecording(`feat/${ID}-x`)).kind).toBe('error');
    });
  });

  it('skips when no board was configured and the implicit root has none', async () => {
    const root = await tempDir('tw-gate-implicit-');
    await withEnv({ TICKETS_DIR_OVERRIDE: undefined, EVENTS_DIR_OVERRIDE: undefined, [GATE_BOARD_ENV]: undefined, BOARD_DIR_OVERRIDE: undefined, CLAUDE_PROJECT_DIR: root }, async () => {
      const r = await resolveRecording(`feat/${ID}-x`);
      expect(r.kind).toBe('skip');
      expect(r.kind === 'skip' && r.reason).toContain(GATE_BOARD_ENV);
    });
  });

  // Root stats through a 000 directory, so the fixture cannot produce EACCES there.
  it.skipIf(process.getuid?.() === 0)('errors, rather than skipping, when the ticket cannot be checked', async () => {
    const saved = process.env.TICKETS_DIR_OVERRIDE;
    const blocked = await tempDir('tw-gate-blocked-');
    await fs.chmod(blocked, 0o000);
    process.env.TICKETS_DIR_OVERRIDE = path.join(blocked, 'tickets');
    try {
      expect((await resolveRecording(`feat/${ID}-x`)).kind).toBe('error');
    } finally {
      process.env.TICKETS_DIR_OVERRIDE = saved;
      await fs.chmod(blocked, 0o700);
    }
  });
});

describe('runGate', () => {
  it('runs every gate in order, records each, and exits 0', async () => {
    const { run, calls } = runner({ test: { summaries: ['      Tests  9 passed (9)'], durationMs: 2500.4 } });
    const append = vi.fn<Append>(async () => {});
    const code = await runGate({ scripts: ALL, recording: RECORD, run, append, print: collect().print });
    expect(code).toBe(GATE_EXIT.OK);
    expect(calls).toEqual(['typecheck', 'lint', 'test']);
    expect(append.mock.calls).toEqual([
      [{ ticketId: ID, step: 'typecheck', state: 'passed', outcomeFrom: 'event', durationMs: 1000, exitCode: 0 }],
      [{ ticketId: ID, step: 'lint', state: 'passed', outcomeFrom: 'event', durationMs: 1000, exitCode: 0 }],
      [{ ticketId: ID, step: 'test', state: 'passed', outcomeFrom: 'event', durationMs: 2500, exitCode: 0, tests: { passed: 9, failed: 0, skipped: 0 } }],
    ]);
  });

  // A step skipped after a failure would leave its earlier `passed` row as the latest, vouching for
  // code nobody checked.
  it('keeps running and recording every gate after one fails, then exits 1', async () => {
    const { run, calls } = runner({ typecheck: { exitCode: 2 } });
    const append = vi.fn<Append>(async () => {});
    const code = await runGate({ scripts: ALL, recording: RECORD, run, append, print: collect().print });
    expect(code).toBe(GATE_EXIT.GATE_FAILED);
    expect(calls).toEqual(['typecheck', 'lint', 'test']);
    expect(append.mock.calls.map(([e]) => [e.step, e.state])).toEqual([['typecheck', 'failed'], ['lint', 'passed'], ['test', 'passed']]);
  });

  // Unattributed, never skipped: writing nothing would leave an earlier `passed` row as the latest.
  it('records a script that could not start as unattributed, and exits 2 — unknown is not failed', async () => {
    const { run, calls } = runner({ lint: { exitCode: null, startError: 'spawn npm ENOENT' } });
    const append = vi.fn<Append>(async () => {});
    const out = collect();
    expect(await runGate({ scripts: ALL, recording: RECORD, run, append, print: out.print })).toBe(GATE_EXIT.NOT_CHECKED);
    expect(calls).toEqual(['typecheck', 'lint', 'test']);
    expect(append.mock.calls.map(([e]) => [e.step, e.state])).toEqual([['typecheck', 'passed'], ['lint', 'unattributed'], ['test', 'passed']]);
    expect(append).toHaveBeenCalledWith({ ticketId: ID, step: 'lint', state: 'unattributed', outcomeFrom: 'event' });
    expect(out.lines.some((l) => l.includes('lint could not be started') && l.includes('ENOENT'))).toBe(true);
  });

  it('ranks a lost record above a script that could not start', async () => {
    const append = vi.fn<Append>(async () => { throw new Error('EIO'); });
    const run = runner({ lint: { exitCode: null, startError: 'x' } }).run;
    expect(await runGate({ scripts: ALL, recording: RECORD, run, append, print: collect().print })).toBe(GATE_EXIT.RECORD_FAILED);
  });

  it('records a killed script as failed with no exit code', async () => {
    const { run } = runner({ typecheck: { exitCode: null } });
    const append = vi.fn<Append>(async () => {});
    expect(await runGate({ scripts: ALL, recording: RECORD, run, append, print: collect().print })).toBe(GATE_EXIT.GATE_FAILED);
    expect(append).toHaveBeenCalledWith({ ticketId: ID, step: 'typecheck', state: 'failed', outcomeFrom: 'event', durationMs: 1000 });
  });

  it('records failed when the summary reports failures, even at exit 0', async () => {
    const { run } = runner({ test: { summaries: ['      Tests  1 failed | 4 passed (5)'] } });
    const append = vi.fn<Append>(async () => {});
    expect(await runGate({ scripts: new Set(['test']), recording: RECORD, run, append, print: collect().print })).toBe(GATE_EXIT.GATE_FAILED);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ step: 'test', state: 'failed', exitCode: 0, tests: { passed: 4, failed: 1, skipped: 0 } }));
  });

  it('omits test counts it could not parse rather than recording zeros', async () => {
    const { run } = runner({});
    const append = vi.fn<Append>(async () => {});
    await runGate({ scripts: new Set(['test']), recording: RECORD, run, append, print: collect().print });
    expect(append).toHaveBeenCalledWith(expect.not.objectContaining({ tests: expect.anything() }));
  });

  it('names a missing script, never runs or records it, and still gates on the rest', async () => {
    const { run, calls } = runner({});
    const append = vi.fn<Append>(async () => {});
    const out = collect();
    expect(await runGate({ scripts: new Set(['typecheck', 'test']), recording: RECORD, run, append, print: out.print })).toBe(GATE_EXIT.OK);
    expect(calls).toEqual(['typecheck', 'test']);
    expect(append.mock.calls.map(([e]) => e.step)).toEqual(['typecheck', 'test']);
    expect(out.lines).toContain('gate: lint — no "lint" script defined, not run');
  });

  it('exits 2 when no gate script is defined — nothing checked is not a pass', async () => {
    const { run, calls } = runner({});
    expect(await runGate({ scripts: new Set(['build']), recording: RECORD, run, print: collect().print })).toBe(GATE_EXIT.NOT_CHECKED);
    expect(calls).toEqual([]);
  });

  it('runs the gates but writes nothing when recording is skipped, exiting on the gate result', async () => {
    const append = vi.fn<Append>(async () => {});
    const out = collect();
    const skip: Recording = { kind: 'skip', reason: 'branch main names no ticket' };
    expect(await runGate({ scripts: ALL, recording: skip, run: runner({}).run, append, print: out.print })).toBe(GATE_EXIT.OK);
    expect(await runGate({ scripts: ALL, recording: skip, run: runner({ test: { exitCode: 1 } }).run, append, print: out.print })).toBe(GATE_EXIT.GATE_FAILED);
    expect(append).not.toHaveBeenCalled();
    expect(out.lines).toContain('gate: NOT RECORDED — branch main names no ticket');
  });

  it('exits 3 when the append throws, even though every gate passed', async () => {
    const append = vi.fn<Append>(async () => { throw new Error('EACCES'); });
    const out = collect();
    expect(await runGate({ scripts: ALL, recording: RECORD, run: runner({}).run, append, print: out.print })).toBe(GATE_EXIT.RECORD_FAILED);
    expect(out.lines.some((l) => l.includes('typecheck could not be appended: EACCES'))).toBe(true);
  });

  it('exits 3, not 1, when a gate fails and its record is lost too', async () => {
    const append = vi.fn<Append>(async () => { throw new Error('EIO'); });
    expect(await runGate({ scripts: ALL, recording: RECORD, run: runner({ lint: { exitCode: 1 } }).run, append, print: collect().print }))
      .toBe(GATE_EXIT.RECORD_FAILED);
  });

  it('exits 3 when the board could not be checked, after still running the gates', async () => {
    const { run, calls } = runner({});
    const append = vi.fn<Append>(async () => {});
    const code = await runGate({ scripts: ALL, recording: { kind: 'error', reason: 'could not check x (EACCES)' }, run, append, print: collect().print });
    expect(code).toBe(GATE_EXIT.RECORD_FAILED);
    expect(calls).toEqual(['typecheck', 'lint', 'test']);
    expect(append).not.toHaveBeenCalled();
  });
});

describe('readScripts', () => {
  it('returns the script names, and an empty set for a package with none', async () => {
    const d = await tempDir('tw-gate-pkg-');
    await fs.writeFile(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'x', lint: 'y' } }));
    expect([...await readScripts(d)].sort()).toEqual(['lint', 'test']);
    await fs.writeFile(path.join(d, 'package.json'), JSON.stringify({ name: 'n' }));
    expect(await readScripts(d)).toEqual(new Set());
  });

  it('throws on a missing or unparseable package.json', async () => {
    const d = await tempDir('tw-gate-pkg-');
    await expect(readScripts(d)).rejects.toThrow();
    await fs.writeFile(path.join(d, 'package.json'), '{');
    await expect(readScripts(d)).rejects.toThrow();
  });
});

describe('spawnScript', () => {
  it('returns on npm exit even when a background process still holds the pipe', { timeout: 20_000 }, async () => {
    const d = await tempDir('tw-gate-bg-');
    await fs.writeFile(path.join(d, 'package.json'), JSON.stringify({
      scripts: { lint: `node -e "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit' }).unref()"` },
    }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const r = await spawnScript(d)('lint');
      expect(r.exitCode).toBe(0);
      expect(r.durationMs).toBeLessThan(7000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reports the real exit code, collects the summary, and scrubs git and board context from the child', async () => {
    const d = await tempDir('tw-gate-spawn-');
    await fs.writeFile(path.join(d, 'package.json'), JSON.stringify({
      scripts: {
        typecheck: 'node -e "console.log(\' Test Files  1 passed (1)\\n      Tests  1 passed (\' + (process.env.GIT_DIR || process.env.BOARD_DIR_OVERRIDE ? 0 : 1) + \')\')"',
        lint: 'node -e "process.exit(7)"',
        // Resolves only when stdin reaches EOF: an inherited TTY would hold it open.
        test: 'node -e "process.stdin.resume(); process.stdin.on(\'end\', () => console.log(\' Test Files  1 passed (1)\\n\\n      Tests  2 passed (2)\'))"',
      },
    }));
    const saved = process.env.GIT_DIR;
    const savedBoard = process.env.BOARD_DIR_OVERRIDE;
    process.env.GIT_DIR = '/nowhere/.git';
    process.env.BOARD_DIR_OVERRIDE = '/central';
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const ok = await spawnScript(d)('typecheck');
      expect(ok.exitCode).toBe(0);
      expect(ok.summaries.map((l) => l.trim())).toEqual(['Tests  1 passed (1)']);
      expect(ok.durationMs).toBeGreaterThan(0);
      expect((await spawnScript(d)('lint')).exitCode).toBe(7);
      expect((await spawnScript(d)('test')).summaries.map((l) => l.trim())).toEqual(['Tests  2 passed (2)']);
      // A test echoing a summary-shaped line, with no Test Files line before it, is not a summary.
      const echo = await tempDir('tw-gate-echo-');
      await fs.writeFile(path.join(echo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(\'      Tests  9 passed (9)\')"' } }));
      expect((await spawnScript(echo)('test')).summaries).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
      if (savedBoard === undefined) delete process.env.BOARD_DIR_OVERRIDE;
      else process.env.BOARD_DIR_OVERRIDE = savedBoard;
      vi.restoreAllMocks();
    }
  });
});

// The whole chain, real processes: branch → board check → npm → appendEvent → readEvents → verify.
describe('cmdGate end to end', () => {
  // A developer's exported gate board would otherwise point these runs at their real board.
  let savedGateBoard: string | undefined;
  beforeEach(() => { savedGateBoard = process.env[GATE_BOARD_ENV]; delete process.env[GATE_BOARD_ENV]; });
  afterEach(() => { if (savedGateBoard !== undefined) process.env[GATE_BOARD_ENV] = savedGateBoard; });

  function git(cwd: string, ...args: string[]) {
    const env = childEnv(process.env);
    const r = spawnSync('git', ['-c', 'user.email=x@example.com', '-c', 'user.name=x', ...args], { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }

  async function repo(branch: string): Promise<string> {
    const d = await tempDir('tw-gate-repo-');
    await fs.writeFile(path.join(d, 'package.json'), JSON.stringify({
      scripts: { typecheck: 'node -e ""', lint: 'node -e ""', test: 'node -e "console.log(\' Test Files  1 passed (1)\\n      Tests  4 passed | 1 skipped (5)\')"' },
    }));
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(d, 'switch', '-q', '-c', branch);
    return d;
  }

  it('records all three results on the branch ticket, and verify trusts them', async () => {
    const t = await createTicket({ title: 'Gate me', type: 'feature', priority: 'low', status: 'in-progress' });
    const d = await repo(`feat/${t.id}-gate-me`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await cmdGate([], d)).toBe(GATE_EXIT.OK);
    } finally {
      vi.restoreAllMocks();
    }
    const { events, skipped } = await readEvents(t.id);
    expect(skipped).toBe(0);
    expect(events.map((e) => [e.step, e.state, e.exitCode, e.outcomeFrom])).toEqual([
      ['typecheck', 'passed', 0, 'event'], ['lint', 'passed', 0, 'event'], ['test', 'passed', 0, 'event'],
    ]);
    expect(events[2].tests).toEqual({ passed: 4, failed: 0, skipped: 1 });
    expect(events.every((e) => typeof e.durationMs === 'number')).toBe(true);
    const { facts } = await gatherTicketFacts({ id: t.id });
    expect(facts[0].trustedSteps).toMatchObject({ typecheck: true, lint: true, test: true });
  });

  it('records a failing gate as failed, with its exit code, and exits 1', async () => {
    const t = await createTicket({ title: 'Gate fails', type: 'feature', priority: 'low', status: 'in-progress' });
    const d = await repo(`feat/${t.id}-gate-fails`);
    const pkg = JSON.parse(await fs.readFile(path.join(d, 'package.json'), 'utf8'));
    pkg.scripts.typecheck = 'node -e "process.exit(4)"';
    await fs.writeFile(path.join(d, 'package.json'), JSON.stringify(pkg));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await cmdGate([], d)).toBe(GATE_EXIT.GATE_FAILED);
    } finally {
      vi.restoreAllMocks();
    }
    const { events } = await readEvents(t.id);
    expect(events.map((e) => [e.step, e.state, e.exitCode])).toEqual([['typecheck', 'failed', 4], ['lint', 'passed', 0], ['test', 'passed', 0]]);
  });

  it('writes no events file anywhere when the board does not hold the ticket', async () => {
    const d = await repo(`feat/${ID}-absent`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await cmdGate([], d)).toBe(GATE_EXIT.OK);
    } finally {
      vi.restoreAllMocks();
    }
    expect(await fs.readdir(dirs.events)).toEqual([]);
    await expect(fs.stat(path.join(d, 'events'))).rejects.toThrow();
  });

  it('refuses arguments and a directory with no package.json', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdGate(['--fast'])).toBe(GATE_EXIT.NOT_CHECKED);
      expect(await cmdGate([], await tempDir('tw-gate-empty-'))).toBe(GATE_EXIT.NOT_CHECKED);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
