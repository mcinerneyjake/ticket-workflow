import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultRegisterExit, defaultRepoName, defaultSetExitCode, holdTestRun, releaseTestRun, type HoldTestRunOptions, type Registry, type RunState } from './hold.js';
import { EXIT, parseSlotRecord, TestRunRefusal, type Liveness } from './slots.js';

// Every case injects env, stateDir, tmpRoot and registry. Inside a vitest worker process.env carries
// VITEST_WORKER_ID, so a helper that read process.env would skip in every case and this whole file
// would pass having exercised nothing — the positive control below is what proves the real path runs.

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type TestRegistry = Registry & { current: Promise<RunState> | undefined };

function registry(): TestRegistry {
  const r: TestRegistry = {
    current: undefined,
    get: () => r.current,
    set: (p) => {
      r.current = p;
    },
  };
  return r;
}

interface Harness {
  readonly opts: HoldTestRunOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly stateDir: string;
  readonly tmpRoot: string;
  readonly log: string[];
  readonly exitCodes: number[];
  readonly exitHooks: Array<() => void>;
  readonly registry: TestRegistry;
  readonly clock: { now: number };
  readonly sleeps: number[];
}

function harness(over: Partial<HoldTestRunOptions> = {}, env: NodeJS.ProcessEnv = {}): Harness {
  const stateDir = temp('tw-hold-state-');
  const tmpRoot = temp('tw-hold-tmp-');
  const log: string[] = [];
  const exitCodes: number[] = [];
  const exitHooks: Array<() => void> = [];
  const reg = registry();
  const clock = { now: 1_700_000_000_000 };
  const sleeps: number[] = [];
  const opts: HoldTestRunOptions = {
    repo: 'demo',
    cwd: '/work/demo',
    env,
    stateDir,
    tmpRoot,
    heartbeatMs: 60_000,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    log: (l) => log.push(l),
    setExitCode: (c) => exitCodes.push(c),
    registerExit: (fn) => exitHooks.push(fn),
    registry: reg,
    ...over,
  };
  return { opts, env, stateDir, tmpRoot, log, exitCodes, exitHooks, registry: reg, clock, sleeps };
}

function plantHeld(stateDir: string, slot: number, pid: number, repo = 'other'): string {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, `slot-${slot}`);
  writeFileSync(file, JSON.stringify({ version: 1, pid, repo, cwd: `/work/${repo}`, startedAt: new Date().toISOString(), tmpDir: '/x' }));
  return file;
}

async function refusal(p: Promise<unknown>): Promise<TestRunRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof TestRunRefusal) return err;
    throw err;
  }
  throw new Error('expected a TestRunRefusal');
}

const alive: Liveness = 'alive';

describe('holdTestRun — the guards, each with a positive control on the same state dir', () => {
  it('is a no-op inside a vitest worker, and the same dir then grants when the guard is absent', async () => {
    const h = harness({}, { VITEST_WORKER_ID: '1' });
    await expect(holdTestRun(h.opts)).resolves.toEqual({ kind: 'skipped', reason: 'worker' });
    expect(readdirSync(h.stateDir)).toEqual([]);
    expect(readdirSync(h.tmpRoot)).toEqual([]);

    const positive = harness({ stateDir: h.stateDir, tmpRoot: h.tmpRoot }, {});
    const outcome = await holdTestRun(positive.opts);
    expect(outcome.kind).toBe('held');
    expect(readdirSync(h.stateDir)).toEqual(['slot-0']);
    await releaseTestRun(positive.registry);
  });

  it('is a no-op on CI, and TEST_SLOTS_FORCE=1 overrides that', async () => {
    const ci = harness({}, { CI: 'true' });
    await expect(holdTestRun(ci.opts)).resolves.toEqual({ kind: 'skipped', reason: 'ci' });
    expect(readdirSync(ci.stateDir)).toEqual([]);

    const forced = harness({ stateDir: ci.stateDir, tmpRoot: ci.tmpRoot }, { CI: 'true', TEST_SLOTS_FORCE: '1' });
    expect((await holdTestRun(forced.opts)).kind).toBe('held');
    await releaseTestRun(forced.registry);
  });

  it('has no other escape hatch: TEST_RUN_HOLD=0 still holds a slot', async () => {
    const h = harness({}, { TEST_RUN_HOLD: '0' });
    expect((await holdTestRun(h.opts)).kind).toBe('held');
    expect(readdirSync(h.stateDir)).toEqual(['slot-0']);
    await releaseTestRun(h.registry);
  });
});

describe('holdTestRun — a granted run', () => {
  it('claims slot 0, points env.TMPDIR at a fresh run dir under <tmpRoot>/<repo>-test, and reports both', async () => {
    const h = harness();
    const outcome = await holdTestRun(h.opts);
    expect(outcome.kind).toBe('held');
    if (outcome.kind !== 'held') return;
    expect(outcome.slot).toBe(0);
    expect(outcome.stateDir).toBe(h.stateDir);
    expect(path.dirname(outcome.tmpDir)).toBe(path.join(h.tmpRoot, 'demo-test'));
    expect(h.env.TMPDIR).toBe(outcome.tmpDir);
    expect(existsSync(outcome.tmpDir)).toBe(true);
    const rec = parseSlotRecord(readFileSync(path.join(h.stateDir, 'slot-0'), 'utf8'));
    expect(rec).toMatchObject({ pid: process.pid, repo: 'demo', cwd: '/work/demo', tmpDir: outcome.tmpDir });
    expect(h.log.some((l) => l.startsWith('[test-run] slot 1/2'))).toBe(true);
    expect(h.exitCodes).toEqual([]);
    expect(h.exitHooks).toHaveLength(1);
    await releaseTestRun(h.registry);
    expect(readdirSync(h.stateDir)).toEqual([]);
    expect(existsSync(outcome.tmpDir)).toBe(false);
  });

  it('honours TEST_SLOTS from env: with slots 0 and 1 held, TEST_SLOTS=3 grants slot 2', async () => {
    const h = harness({}, { TEST_SLOTS: '3' });
    plantHeld(h.stateDir, 0, process.pid);
    plantHeld(h.stateDir, 1, process.pid);
    const outcome = await holdTestRun(h.opts);
    expect(outcome).toMatchObject({ kind: 'held', slot: 2 });
    await releaseTestRun(h.registry);
  });

  it('takes the slot once per process: a second call shares the first outcome and adds no file', async () => {
    const h = harness();
    const first = await holdTestRun(h.opts);
    const second = await holdTestRun(h.opts);
    expect(second).toBe(first);
    expect(readdirSync(h.stateDir)).toEqual(['slot-0']);
    await releaseTestRun(h.registry);
  });

  it('keeps the heartbeat moving so a fresh holder is never reclaimed', async () => {
    const h = harness({ heartbeatMs: 20, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    await holdTestRun(h.opts);
    const file = path.join(h.stateDir, 'slot-0');
    const before = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 120));
    expect(statSync(file).mtimeMs).toBeGreaterThan(before);
    await releaseTestRun(h.registry);
  });

  it('the exit hook releases too, and a later releaseTestRun is a harmless no-op', async () => {
    const h = harness();
    const outcome = await holdTestRun(h.opts);
    h.exitHooks[0]();
    expect(readdirSync(h.stateDir)).toEqual([]);
    expect(outcome.kind === 'held' && existsSync(outcome.tmpDir)).toBe(false);
    await expect(releaseTestRun(h.registry)).resolves.toBeUndefined();
    expect(h.exitCodes).toEqual([]);
  });
});

describe('holdTestRun — waiting and refusing', () => {
  it('waits while the only slot is held, prints the holder, and refuses with SLOTS_FULL at the budget', async () => {
    const h = harness({ slots: 1, waitMs: 5000, probe: () => alive });
    plantHeld(h.stateDir, 0, 4242, 'busy-repo');
    const err = await refusal(holdTestRun(h.opts));
    expect(err.code).toBe(EXIT.SLOTS_FULL);
    expect(err.message).toContain('pid 4242 busy-repo /work/busy-repo');
    expect(h.exitCodes).toEqual([EXIT.SLOTS_FULL]);
    expect(h.log.some((l) => l.includes('waiting for a test slot') && l.includes('pid 4242'))).toBe(true);
    expect(h.sleeps).toEqual([1000, 2000, 2000]); // backoff, capped by the remaining budget
    expect(readdirSync(h.stateDir)).toEqual(['slot-0']); // theirs, untouched
    expect(readdirSync(path.join(h.tmpRoot, 'demo-test'))).toEqual([]); // our run dir was removed
    expect(h.registry.current).toBeUndefined(); // a failed acquire does not stick
  });

  it('proceeds within one poll of the holder releasing', async () => {
    const h = harness({ slots: 1, waitMs: 60_000, probe: () => alive });
    const held = plantHeld(h.stateDir, 0, 4242);
    const base = h.opts.sleep;
    let polls = 0;
    const opts: HoldTestRunOptions = {
      ...h.opts,
      sleep: async (ms) => {
        polls += 1;
        if (polls === 2) unlinkSync(held);
        if (base) await base(ms);
      },
    };
    const outcome = await holdTestRun(opts);
    expect(outcome).toMatchObject({ kind: 'held', slot: 0 });
    expect(polls).toBe(2);
    expect(h.exitCodes).toEqual([]);
    await releaseTestRun(h.registry);
  });

  it('waitMs=0 tries exactly once and refuses', async () => {
    const h = harness({ slots: 1 }, { TEST_SLOTS_WAIT_MS: '0' });
    plantHeld(h.stateDir, 0, process.pid);
    const err = await refusal(holdTestRun(h.opts));
    expect(err.code).toBe(EXIT.SLOTS_FULL);
    expect(h.sleeps).toEqual([]);
  });

  it('refuses a bad TEST_SLOTS with STATE_UNREADABLE before touching the state dir', async () => {
    const h = harness({}, { TEST_SLOTS: 'abc' });
    const err = await refusal(holdTestRun(h.opts));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
    expect(h.exitCodes).toEqual([EXIT.STATE_UNREADABLE]);
    expect(readdirSync(h.stateDir)).toEqual([]);
  });

  it('refuses a corrupt slot with STATE_UNREADABLE, distinct from SLOTS_FULL, and removes its run dir', async () => {
    const h = harness({ slots: 1 });
    mkdirSync(h.stateDir, { recursive: true });
    writeFileSync(path.join(h.stateDir, 'slot-0'), 'garbage');
    const err = await refusal(holdTestRun(h.opts));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
    expect(err.code).not.toBe(EXIT.SLOTS_FULL);
    expect(readdirSync(path.join(h.tmpRoot, 'demo-test'))).toEqual([]); // a refused run holds nothing
    expect(h.env.TMPDIR).toBeUndefined();
  });

  it('refuses with TMPDIR_UNAVAILABLE when the run root is a file, and claims no slot', async () => {
    const h = harness();
    writeFileSync(path.join(h.tmpRoot, 'demo-test'), 'x');
    const err = await refusal(holdTestRun(h.opts));
    expect(err.code).toBe(EXIT.TMPDIR_UNAVAILABLE);
    expect(h.exitCodes).toEqual([EXIT.TMPDIR_UNAVAILABLE]);
    expect(readdirSync(h.stateDir)).toEqual([]);
    expect(h.env.TMPDIR).toBeUndefined();
  });
});

describe('releaseTestRun — the release dimension', () => {
  it('warns, does not throw and sets no exit code when the slot was already removed', async () => {
    const h = harness();
    await holdTestRun(h.opts);
    unlinkSync(path.join(h.stateDir, 'slot-0'));
    await expect(releaseTestRun(h.registry)).resolves.toBeUndefined();
    expect(h.log.some((l) => l.includes('WARNING') && l.includes('removed mid-run'))).toBe(true);
    expect(h.exitCodes).toEqual([]);
  });

  it('warns and leaves a slot that was reissued to another pid', async () => {
    const h = harness();
    await holdTestRun(h.opts);
    const file = plantHeld(h.stateDir, 0, 1, 'thief');
    await releaseTestRun(h.registry);
    expect(h.log.some((l) => l.includes('reissued'))).toBe(true);
    expect(parseSlotRecord(readFileSync(file, 'utf8'))?.repo).toBe('thief');
  });

  it.skipIf(isRoot)('rethrows and sets exit code 1 when the slot cannot be released', async () => {
    const h = harness();
    await holdTestRun(h.opts);
    chmodSync(h.stateDir, 0o500);
    await expect(releaseTestRun(h.registry)).rejects.toThrow();
    expect(h.exitCodes).toEqual([1]);
    chmodSync(h.stateDir, 0o700);
  });

  it('is a no-op on an empty registry and on a registry whose acquire was refused', async () => {
    const empty = registry();
    await expect(releaseTestRun(empty)).resolves.toBeUndefined();
    const h = harness({}, { TEST_SLOTS: 'nope' });
    await refusal(holdTestRun(h.opts));
    h.registry.set(Promise.reject(new Error('refused earlier')));
    await expect(releaseTestRun(h.registry)).resolves.toBeUndefined();
  });
});

describe('the process-level defaults, exercised directly because the main process is never instrumented', () => {
  it('defaultSetExitCode writes process.exitCode', () => {
    const saved = process.exitCode;
    defaultSetExitCode(75);
    expect(process.exitCode).toBe(75);
    process.exitCode = saved;
  });

  it('defaultRegisterExit registers a one-shot exit listener', () => {
    const before = process.listenerCount('exit');
    const fn = (): void => undefined;
    defaultRegisterExit(fn);
    expect(process.listenerCount('exit')).toBe(before + 1);
    process.removeListener('exit', fn);
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('defaultRepoName reads a sanitised package name, and falls back to the directory name', () => {
    const dir = temp('tw-repo-name-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@scope/my pkg' }));
    expect(defaultRepoName(dir)).toBe('scope-my-pkg');
    const bare = temp('tw-repo-bare-');
    expect(defaultRepoName(bare)).toBe(path.basename(bare));
    writeFileSync(path.join(bare, 'package.json'), '{not json');
    expect(defaultRepoName(bare)).toBe(path.basename(bare));
  });
});
